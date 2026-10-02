/**
 * Sends due alerts from the outbox through Expo's push service.
 *
 * Each event is claimed with a compare-and-set (pending → sending) so two drains
 * running at once never send it twice. Recipients are every phone following any
 * of the event's targets, each phone once (notification_deliveries' primary key),
 * filtered by the phone's own alert switches.
 *
 * A delivery row is 'queued' until Expo answers, then 'sent', 'error' (worth
 * another try: Expo was down or rate-limited us) or 'failed' (it never will be:
 * the phone uninstalled the app, the message is too big, our credentials are
 * wrong). An event is 'sent' only once every recipient's delivery is settled;
 * otherwise it goes back to 'pending' and the next drain sends what is left,
 * skipping phones already alerted. A drain that dies mid-send leaves its event in
 * 'sending'; the next drain returns it after STUCK_AFTER_MS (so a phone may then,
 * rarely, get that alert twice — never none).
 *
 * Expo's ticket only says the message was accepted. The receipts pass
 * (checkReceipts, run by the scheduled drain) asks Expo what happened to tickets
 * sent at least RECEIPT_AFTER_MS ago and switches off phones that are gone.
 */
import { db } from "../supabase";
import { DEFAULT_ALERT_PREFS, type MAlertPrefs } from "../mobile/contract";
import type { AlertPayload, Target } from "./compose";

const EXPO_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

export const MAX_ATTEMPTS = 5;
export const STUCK_AFTER_MS = 5 * 60_000;
export const RECEIPT_AFTER_MS = 15 * 60_000;
/** Expo keeps receipts for a day; older tickets are not asked about. */
const RECEIPT_WINDOW_MS = 24 * 60 * 60_000;

/** Expo errors that another try will not fix. Anything else (MessageRateExceeded, unknown) is retried. */
const PERMANENT_ERRORS = new Set(["DeviceNotRegistered", "MessageTooBig", "InvalidCredentials", "MismatchSenderId"]);
/** Errors that mean our setup is wrong, not the phone: worth a loud log line. */
const CONFIG_ERRORS = new Set(["InvalidCredentials", "MessageTooBig", "MismatchSenderId"]);

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

interface Ticket {
  status: string;
  id?: string;
  message?: string;
  details?: { error?: string };
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

function expoHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  return headers;
}

async function sendExpo(messages: { to: string; title: string; body: string; data: Record<string, unknown>; sound: "default"; channelId: string }[]): Promise<Ticket[]> {
  const res = await fetch(EXPO_URL, { method: "POST", headers: expoHeaders(), body: JSON.stringify(messages) });
  if (!res.ok) throw new Error(`Expo push ${res.status}`);
  const json = (await res.json()) as { data?: Ticket[] };
  return json.data ?? [];
}

function logConfigError(where: string, code: string, message: string | undefined) {
  if (CONFIG_ERRORS.has(code)) console.error(`[push:${where}] ${code} — check the Expo/FCM/APNs setup: ${message ?? ""}`);
}

/** Switches off phones Expo says no longer have the app. */
async function disableDevices(ids: string[]) {
  if (!ids.length) return;
  await db().from("push_devices").update({ disabled_at: new Date().toISOString(), expo_push_token: null }).in("id", ids);
}

/** Events whose drain died mid-send go back to the queue (or give up after MAX_ATTEMPTS). */
export async function recoverStuck(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  await db()
    .from("notification_events")
    .update({ status: "failed", error: "stuck while sending" })
    .eq("status", "sending")
    .lt("claimed_at", cutoff)
    .gte("attempts", MAX_ATTEMPTS);
  await db()
    .from("notification_events")
    .update({ status: "pending", error: "stuck while sending" })
    .eq("status", "sending")
    .lt("claimed_at", cutoff)
    .lt("attempts", MAX_ATTEMPTS);
}

/** Sends one claimed event to whoever has not had it yet. Returns how many went out and, if some are left to retry, why. */
async function sendEvent(ev: EventRow): Promise<{ sent: number; retry: string | null }> {
  const devices = await recipientsFor(ev.payload.targets ?? [], ev.payload.category);
  if (!devices.length) return { sent: 0, retry: null };
  const ids = devices.map((d) => d.id);
  // One delivery row per phone; rows from an earlier try are kept as they are.
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await db()
      .from("notification_deliveries")
      .upsert(ids.slice(i, i + 200).map((id) => ({ event_id: ev.id, device_id: id })), { onConflict: "event_id,device_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  // Phones already settled for this event (alerted, or never will be) are skipped.
  const settled = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db()
      .from("notification_deliveries")
      .select("device_id")
      .eq("event_id", ev.id)
      .in("status", ["sent", "failed"])
      .in("device_id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { device_id: string }[]) settled.add(r.device_id);
  }
  const todo = devices.filter((d) => !settled.has(d.id));

  let sent = 0;
  let retry: string | null = null;
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    let tickets: Ticket[];
    try {
      tickets = await sendExpo(
        chunk.map((d) => ({
          to: d.expo_push_token!,
          title: ev.payload.title,
          body: ev.payload.body,
          data: { url: ev.payload.url, kind: ev.kind },
          sound: "default",
          channelId: ev.payload.category === "major" ? "announcements" : "matches",
        })),
      );
    } catch (err) {
      // Nothing in this chunk went out; its rows stay 'queued' for the next try.
      retry = err instanceof Error ? err.message : String(err);
      continue;
    }
    const at = new Date().toISOString();
    const dead: string[] = [];
    const rows = chunk.map((d, j) => {
      const t = tickets[j];
      if (t?.status === "ok") {
        sent++;
        return { event_id: ev.id, device_id: d.id, status: "sent", ticket_id: t.id ?? null, error: null, sent_at: at };
      }
      const code = t?.details?.error ?? (t ? "unknown" : "no ticket");
      if (code === "DeviceNotRegistered") dead.push(d.id);
      logConfigError("send", code, t?.message);
      const permanent = PERMANENT_ERRORS.has(code);
      if (!permanent) retry = `Expo ${code}`;
      return { event_id: ev.id, device_id: d.id, status: permanent ? "failed" : "error", ticket_id: null, error: code, sent_at: null };
    });
    // One request for the whole chunk: every row exists, so the upsert only updates.
    const { error } = await db().from("notification_deliveries").upsert(rows, { onConflict: "event_id,device_id" });
    if (error) console.error("[push:send] could not record deliveries", ev.id, error.message);
    await disableDevices(dead);
  }
  return { sent, retry };
}

/** Sends everything due now. Returns how many alerts went out. */
export async function drainNotifications(limit = 25): Promise<{ events: number; sent: number }> {
  await recoverStuck();
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
      .update({ status: "sending", attempts: ev.attempts + 1, claimed_at: new Date().toISOString() })
      .eq("id", ev.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;
    events++;
    const giveUp = ev.attempts + 1 >= MAX_ATTEMPTS;
    try {
      const r = await sendEvent(ev);
      sent += r.sent;
      if (r.retry) {
        await db()
          .from("notification_events")
          .update({ status: giveUp ? "failed" : "pending", error: r.retry.slice(0, 300) })
          .eq("id", ev.id);
      } else {
        await db().from("notification_events").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).eq("id", ev.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db()
        .from("notification_events")
        .update({ status: giveUp ? "failed" : "pending", error: message.slice(0, 300) })
        .eq("id", ev.id);
    }
  }
  return { events, sent };
}

/**
 * Asks Expo what happened to tickets sent RECEIPT_AFTER_MS ago or more. Phones
 * that uninstalled the app are switched off; setup errors are logged loudly. A
 * ticket with no receipt yet is asked about again on the next run.
 */
export async function checkReceipts(limit = 1000): Promise<{ checked: number; failed: number }> {
  const nowMs = Date.now();
  const { data, error } = await db()
    .from("notification_deliveries")
    .select("event_id, device_id, ticket_id")
    .eq("status", "sent")
    .is("receipt_checked_at", null)
    .not("ticket_id", "is", null)
    .lte("sent_at", new Date(nowMs - RECEIPT_AFTER_MS).toISOString())
    .gte("sent_at", new Date(nowMs - RECEIPT_WINDOW_MS).toISOString())
    .order("sent_at")
    .limit(limit);
  if (error || !data?.length) return { checked: 0, failed: 0 };
  const rows = data as { event_id: string; device_id: string; ticket_id: string }[];
  let checked = 0;
  let failed = 0;
  // Expo takes up to 1000 receipt ids per request.
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const res = await fetch(EXPO_RECEIPTS_URL, { method: "POST", headers: expoHeaders(), body: JSON.stringify({ ids: chunk.map((r) => r.ticket_id) }) });
    if (!res.ok) {
      console.error(`[push:receipts] Expo getReceipts ${res.status}`);
      break;
    }
    const receipts = ((await res.json()) as { data?: Record<string, Ticket> }).data ?? {};
    const at = new Date().toISOString();
    const ok: Record<string, unknown>[] = [];
    const bad: Record<string, unknown>[] = [];
    const dead = new Set<string>();
    for (const r of chunk) {
      const rc = receipts[r.ticket_id];
      if (!rc) continue; // not ready yet: asked again next run
      checked++;
      if (rc.status === "ok") {
        ok.push({ event_id: r.event_id, device_id: r.device_id, receipt_checked_at: at });
        continue;
      }
      failed++;
      const code = rc.details?.error ?? "unknown";
      if (code === "DeviceNotRegistered") dead.add(r.device_id);
      logConfigError("receipts", code, rc.message);
      bad.push({ event_id: r.event_id, device_id: r.device_id, status: "failed", error: code, receipt_checked_at: at });
    }
    // Every row in one upsert carries the same columns, so delivered and failed go separately.
    for (const batch of [ok, bad]) {
      if (!batch.length) continue;
      const { error: upErr } = await db().from("notification_deliveries").upsert(batch, { onConflict: "event_id,device_id" });
      if (upErr) console.error("[push:receipts] could not record receipts", upErr.message);
    }
    await disableDevices([...dead]);
  }
  return { checked, failed };
}
