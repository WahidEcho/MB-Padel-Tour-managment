/**
 * Sends due alerts from the outbox through Expo's push service.
 *
 * Each event is claimed with a compare-and-set (pending → sending) so two drains
 * running at once never send it twice. Recipients are every phone following any
 * of the event's targets, each phone once (notification_deliveries' primary key),
 * filtered by the phone's own alert switches.
 */
import { db } from "../supabase";
import { DEFAULT_ALERT_PREFS, type MAlertPrefs } from "../mobile/contract";
import type { AlertPayload, Target } from "./compose";

const EXPO_URL = "https://exp.host/--/api/v2/push/send";

interface EventRow {
  id: string;
  kind: string;
  payload: AlertPayload;
  attempts: number;
}

interface DeviceRow {
  id: string;
  installation_id: string;
  user_id: string | null;
  expo_push_token: string | null;
  prefs: Partial<MAlertPrefs> | null;
}

export async function recipientsFor(targets: Target[], category: keyof MAlertPrefs): Promise<DeviceRow[]> {
  if (!targets.length) return [];
  const owners = { install: new Set<string>(), user: new Set<string>() };
  const byKind = new Map<string, string[]>();
  for (const t of targets) byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), t.key]);
  for (const [kind, keys] of byKind) {
    const { data } = await db().from("follows").select("owner_kind, owner_id").eq("target_kind", kind).in("target_key", keys);
    for (const f of (data ?? []) as { owner_kind: "install" | "user"; owner_id: string }[]) owners[f.owner_kind].add(f.owner_id);
  }
  const devices = new Map<string, DeviceRow>();
  const cols = "id, installation_id, user_id, expo_push_token, prefs";
  const installs = [...owners.install];
  const users = [...owners.user];
  for (let i = 0; i < installs.length; i += 200) {
    const { data } = await db().from("push_devices").select(cols).in("installation_id", installs.slice(i, i + 200)).is("disabled_at", null);
    for (const d of (data ?? []) as DeviceRow[]) devices.set(d.id, d);
  }
  for (let i = 0; i < users.length; i += 200) {
    const { data } = await db().from("push_devices").select(cols).in("user_id", users.slice(i, i + 200)).is("disabled_at", null);
    for (const d of (data ?? []) as DeviceRow[]) devices.set(d.id, d);
  }
  return [...devices.values()].filter((d) => d.expo_push_token && ({ ...DEFAULT_ALERT_PREFS, ...(d.prefs ?? {}) })[category] !== false);
}

async function sendExpo(messages: { to: string; title: string; body: string; data: Record<string, unknown>; sound: "default"; channelId: string }[]) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  const res = await fetch(EXPO_URL, { method: "POST", headers, body: JSON.stringify(messages) });
  if (!res.ok) throw new Error(`Expo push ${res.status}`);
  const json = (await res.json()) as { data?: { status: string; id?: string; details?: { error?: string } }[] };
  return json.data ?? [];
}

/** Sends everything due now. Returns how many alerts went out. */
export async function drainNotifications(limit = 25): Promise<{ events: number; sent: number }> {
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from("notification_events")
    .select("id, kind, payload, attempts")
    .eq("status", "pending")
    .lte("fire_at", now)
    .order("fire_at")
    .limit(limit);
  if (error || !data?.length) return { events: 0, sent: 0 };
  let sent = 0;
  let events = 0;
  for (const ev of data as EventRow[]) {
    const { data: claimed } = await db()
      .from("notification_events")
      .update({ status: "sending", attempts: ev.attempts + 1 })
      .eq("id", ev.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;
    events++;
    try {
      const devices = await recipientsFor(ev.payload.targets ?? [], ev.payload.category);
      // One delivery row per phone; a phone already alerted for this event is skipped.
      const fresh: DeviceRow[] = [];
      for (let i = 0; i < devices.length; i += 200) {
        const chunk = devices.slice(i, i + 200);
        const { data: inserted } = await db()
          .from("notification_deliveries")
          .upsert(chunk.map((d) => ({ event_id: ev.id, device_id: d.id })), { onConflict: "event_id,device_id", ignoreDuplicates: true })
          .select("device_id");
        const ids = new Set(((inserted ?? []) as { device_id: string }[]).map((r) => r.device_id));
        fresh.push(...chunk.filter((d) => ids.has(d.id)));
      }
      for (let i = 0; i < fresh.length; i += 100) {
        const chunk = fresh.slice(i, i + 100);
        const tickets = await sendExpo(
          chunk.map((d) => ({
            to: d.expo_push_token!,
            title: ev.payload.title,
            body: ev.payload.body,
            data: { url: ev.payload.url, kind: ev.kind },
            sound: "default",
            channelId: ev.payload.category === "major" ? "announcements" : "matches",
          })),
        );
        for (let j = 0; j < chunk.length; j++) {
          const t = tickets[j];
          const ok = t?.status === "ok";
          if (ok) sent++;
          await db()
            .from("notification_deliveries")
            .update({ status: ok ? "sent" : "error", ticket_id: t?.id ?? null, error: ok ? null : (t?.details?.error ?? "unknown") })
            .eq("event_id", ev.id)
            .eq("device_id", chunk[j].id);
          if (t?.details?.error === "DeviceNotRegistered") {
            await db().from("push_devices").update({ disabled_at: now, expo_push_token: null }).eq("id", chunk[j].id);
          }
        }
      }
      await db().from("notification_events").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).eq("id", ev.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db()
        .from("notification_events")
        .update({ status: ev.attempts + 1 >= 5 ? "failed" : "pending", error: message.slice(0, 300) })
        .eq("id", ev.id);
    }
  }
  return { events, sent };
}
