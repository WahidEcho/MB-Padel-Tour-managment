"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/supabase";
import { parseAudience } from "@/lib/messaging/audience";
import { validateCompose, type ComposeInput } from "@/lib/messaging/compose";
import { whatsappTemplates } from "@/lib/messaging/data";
import { maskPhone } from "@/lib/messaging/phone";
import { drainMessages, finishIfDone, recipientsOf, retryFailed, sendTestMessage, startAnnouncement, type AnnouncementRow } from "@/lib/messaging/queue";
import { planDeliveries, type ChannelPreview } from "@/lib/messaging/recipients";
import { missingFields } from "@/lib/messaging/render";
import { channelReady, transportMode } from "@/lib/messaging/transport";
import { recipientsFor } from "@/lib/notify/drain";
import type { Channel } from "@/lib/messaging/status";
import type { Target } from "@/lib/notify/compose";

/** What the client sends; re-checked here, never trusted. */
function clean(raw: ComposeInput): ComposeInput {
  const kind = raw.kind === "access_codes" || raw.kind === "new_tournament" ? raw.kind : "announcement";
  const channels = [...new Set((raw.channels ?? []).filter((c) => c === "email" || c === "whatsapp" || c === "push"))];
  const w = raw.whatsapp;
  return {
    kind,
    title: String(raw.title ?? "").trim().slice(0, 160),
    body: String(raw.body ?? "").slice(0, 5000),
    channels,
    audience: parseAudience(raw.audience),
    whatsapp:
      channels.includes("whatsapp") && w?.name
        ? {
            name: String(w.name),
            language: String(w.language || "en"),
            params: (w.params ?? []).map((p) => ({ field: p.field, text: String(p.text ?? "").slice(0, 1000) })),
            headerImageUrl: w.headerImageUrl ? String(w.headerImageUrl) : null,
            buttons: (w.buttons ?? []).map((b) => ({ index: Number(b.index) || 0, source: { field: b.source.field, text: String(b.source.text ?? "").slice(0, 200) } })),
          }
        : null,
    cta: raw.cta?.url ? { label: String(raw.cta.label || "Open").slice(0, 60), url: String(raw.cta.url).slice(0, 500) } : null,
    tournamentId: raw.tournamentId && /^[0-9a-f-]{36}$/i.test(raw.tournamentId) ? raw.tournamentId : null,
  };
}

async function specFor(input: ComposeInput) {
  if (!input.whatsapp) return null;
  const { templates } = await whatsappTemplates();
  return templates.find((t) => t.name === input.whatsapp!.name && t.language === input.whatsapp!.language) ?? null;
}

function pushTargets(input: ComposeInput): Target[] {
  const a = input.audience;
  if (a.type === "tournament") return [{ kind: "tournament", key: a.tournamentId }];
  if (a.type === "nation") return [{ kind: "nation", key: a.nationCode }];
  if (a.type === "app_users") return [{ kind: "all", key: "all" }];
  return [];
}

export interface PreviewResult {
  ok: boolean;
  errors: string[];
  people: number;
  channels: Partial<Record<Channel, ChannelPreview>>;
  pushDevices: number | null;
  rejectedLines: string[];
  sample: { name: string; email: string | null; phone: string | null; code: string | null }[];
  missingMergeFields: string[];
  ready: Partial<Record<Channel, { ok: boolean; why?: string }>>;
  transport: "dry-run" | "live";
}

export async function previewAction(raw: ComposeInput): Promise<PreviewResult> {
  await requirePermission("send_messages");
  let input: ComposeInput;
  try {
    input = clean(raw);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], people: 0, channels: {}, pushDevices: null, rejectedLines: [], sample: [], missingMergeFields: [], ready: {}, transport: transportMode() };
  }
  const errors = validateCompose(input, await specFor(input));
  const { recipients, rejected } = await recipientsOf({ audience: input.audience, tournament_id: input.tournamentId });
  const channels = input.channels.filter((c): c is Channel => c !== "push");
  const { preview } = planDeliveries(recipients, channels, { requireCode: input.kind === "access_codes" });
  const pushDevices = input.channels.includes("push") ? (await recipientsFor(pushTargets(input), "major")).length : null;
  const missing = new Set<string>();
  const text = `${input.title}\n${input.body}\n${input.cta?.url ?? ""}`;
  for (const r of recipients.slice(0, 500)) for (const f of missingFields(text, r.vars)) missing.add(f);
  return {
    ok: errors.length === 0,
    errors,
    people: recipients.length,
    channels: preview,
    pushDevices,
    rejectedLines: rejected.slice(0, 20),
    sample: recipients.slice(0, 6).map((r) => ({
      name: r.name,
      email: r.email,
      phone: r.phone ? maskPhone(r.phone) : null,
      code: r.vars.code ? "•••" + String(r.vars.code).slice(-2) : null,
    })),
    missingMergeFields: [...missing],
    ready: Object.fromEntries(channels.map((c) => [c, channelReady(c)])),
    transport: transportMode(),
  };
}

export async function sendTestAction(raw: ComposeInput, to: { email?: string; phone?: string }) {
  const role = await requirePermission("send_messages");
  const input = clean(raw);
  // Use the first real recipient's values so the test reads like the real thing.
  const { recipients, base } = await recipientsOf({ audience: input.audience, tournament_id: input.tournamentId }).catch(() => ({ recipients: [], base: {} }));
  const first = recipients.find((r) => input.kind !== "access_codes" || r.vars.code) ?? recipients[0];
  const vars = { ...base, ...(first?.vars ?? { name: "Test Player" }), ...(input.kind === "access_codes" && !first?.vars.code ? { code: "TEST-1234" } : {}) };
  const result = await sendTestMessage(
    { kind: input.kind, title: input.title || "(no title)", body: input.body, cta: input.cta, whatsapp_template: input.whatsapp },
    { email: to.email?.trim() || null, phone: to.phone?.trim() || null },
    vars,
  );
  await audit({ actor_role: role, action: "MESSAGE_TEST_SENT", entity_type: "message", new_value: { title: input.title, email: !!to.email, whatsapp: !!to.phone } });
  return { ...result, usedName: first?.name ?? "Test Player" };
}

export async function createAndSendAction(raw: ComposeInput): Promise<{ id?: string; errors?: string[]; queued?: number; skipped?: number }> {
  const role = await requirePermission("send_messages");
  let input: ComposeInput;
  try {
    input = clean(raw);
  } catch (err) {
    return { errors: [err instanceof Error ? err.message : String(err)] };
  }
  const errors = validateCompose(input, await specFor(input));
  if (errors.length) return { errors };
  for (const c of input.channels) {
    if (c === "push") continue;
    const r = channelReady(c);
    if (!r.ok) return { errors: [`${c === "email" ? "Email" : "WhatsApp"} is not set up on the server: ${r.why}`] };
  }
  const { data, error } = await db()
    .from("message_announcements")
    .insert({
      kind: input.kind,
      title: input.title,
      body: input.body,
      channels: input.channels,
      audience: input.audience,
      whatsapp_template: input.whatsapp,
      cta: input.cta,
      tournament_id: input.tournamentId ?? (input.audience.type === "tournament" ? input.audience.tournamentId : null),
      created_by: role,
    })
    .select("id")
    .single();
  if (error) return { errors: [error.message] };
  const id = (data as { id: string }).id;
  try {
    const r = await startAnnouncement(id);
    await audit({ actor_role: role, action: "ANNOUNCEMENT_SENT", entity_type: "message_announcement", entity_id: id, new_value: { title: input.title, channels: input.channels, audience: input.audience.type, queued: r.queued, skipped: r.skipped } });
    revalidatePath("/admin/announcements");
    return { id, queued: r.queued, skipped: r.skipped };
  } catch (err) {
    return { id, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/** The detail page calls this in a loop while an announcement is sending. */
export async function pumpAction(id: string): Promise<{ status: string; remaining: number }> {
  await requirePermission("send_messages");
  const r = await drainMessages({ budgetMs: 15_000, announcementId: id });
  if (!r.remaining) await finishIfDone(id);
  const { data } = await db().from("message_announcements").select("status").eq("id", id).maybeSingle();
  return { status: (data as Pick<AnnouncementRow, "status"> | null)?.status ?? "unknown", remaining: r.remaining };
}

export async function retryFailedAction(formData: FormData) {
  const role = await requirePermission("send_messages");
  const id = String(formData.get("id"));
  const channel = formData.get("channel");
  const n = await retryFailed(id, channel === "email" || channel === "whatsapp" ? channel : undefined);
  await audit({ actor_role: role, action: "ANNOUNCEMENT_RETRY", entity_type: "message_announcement", entity_id: id, new_value: { retried: n, channel } });
  revalidatePath(`/admin/announcements/${id}`);
}

export async function cancelAction(formData: FormData) {
  const role = await requirePermission("send_messages");
  const id = String(formData.get("id"));
  await db().from("message_announcements").update({ status: "cancelled", completed_at: new Date().toISOString() }).eq("id", id).eq("status", "sending");
  await db()
    .from("message_deliveries")
    .update({ status: "skipped", error_code: "cancelled", error_reason: "Announcement cancelled before it was sent" })
    .eq("announcement_id", id)
    .eq("status", "queued");
  await audit({ actor_role: role, action: "ANNOUNCEMENT_CANCELLED", entity_type: "message_announcement", entity_id: id });
  revalidatePath(`/admin/announcements/${id}`);
}

export async function refreshTemplatesAction() {
  await requirePermission("send_messages");
  await whatsappTemplates(true);
  revalidatePath("/admin/announcements/new");
}
