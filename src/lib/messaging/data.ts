/**
 * Reads for the console's Announcements pages. Server only.
 */
import { db } from "../supabase";
import { summarize, type ChannelStats, type Channel, type StatRow } from "./status";
import { listTemplates, waConfig, type TemplateSpec } from "./whatsapp";
import type { AnnouncementRow } from "./queue";

export type Stats = ReturnType<typeof summarize>;

export async function announcementStats(ids: string[]): Promise<Map<string, Stats>> {
  const out = new Map<string, Stats>();
  if (!ids.length) return out;
  const { data, error } = await db().from("message_delivery_stats").select("announcement_id, channel, status, not_on_whatsapp, n").in("announcement_id", ids);
  if (error) throw new Error(error.message);
  const byId = new Map<string, StatRow[]>();
  for (const r of (data ?? []) as (StatRow & { announcement_id: string })[]) byId.set(r.announcement_id, [...(byId.get(r.announcement_id) ?? []), r]);
  for (const id of ids) out.set(id, summarize(byId.get(id) ?? []));
  return out;
}

export interface PushStats {
  status: string;
  devices: number;
  sent: number;
  failed: number;
  pending: number;
}

/** What the app-push side of an announcement did, from the existing alert outbox. */
export async function pushStats(dedupeKey: string | null): Promise<PushStats | null> {
  if (!dedupeKey) return null;
  const { data: ev } = await db().from("notification_events").select("id, status").eq("dedupe_key", dedupeKey).maybeSingle();
  const e = ev as { id: string; status: string } | null;
  if (!e) return { status: "pending", devices: 0, sent: 0, failed: 0, pending: 0 };
  const { data } = await db().from("notification_deliveries").select("status").eq("event_id", e.id).limit(10000);
  const rows = (data ?? []) as { status: string }[];
  return {
    status: e.status,
    devices: rows.length,
    sent: rows.filter((r) => r.status === "sent").length,
    failed: rows.filter((r) => r.status === "failed").length,
    pending: rows.filter((r) => r.status === "queued" || r.status === "error").length,
  };
}

export async function listAnnouncements(limit = 50): Promise<AnnouncementRow[]> {
  const { data, error } = await db().from("message_announcements").select("*").order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as AnnouncementRow[];
}

export async function getAnnouncement(id: string): Promise<AnnouncementRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await db().from("message_announcements").select("*").eq("id", id).maybeSingle();
  return (data as AnnouncementRow | null) ?? null;
}

export interface DeliveryListRow {
  id: string;
  channel: Channel;
  recipient_kind: string;
  recipient_id: string | null;
  recipient_name: string | null;
  address: string | null;
  status: string;
  error_code: string | null;
  error_reason: string | null;
  attempts: number;
  provider_message_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  updated_at: string;
}

export type DeliveryFilter = "all" | "pending" | "sent" | "delivered" | "read" | "failed" | "not_on_whatsapp" | "bounced" | "skipped" | "complained";

export const FILTERS: { key: DeliveryFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "delivered", label: "Delivered" },
  { key: "read", label: "Read / opened" },
  { key: "failed", label: "Failed" },
  { key: "not_on_whatsapp", label: "Not on WhatsApp" },
  { key: "bounced", label: "Bounced" },
  { key: "complained", label: "Spam complaints" },
  { key: "skipped", label: "Not sent" },
];

const COLS = "id, channel, recipient_kind, recipient_id, recipient_name, address, status, error_code, error_reason, attempts, provider_message_id, sent_at, delivered_at, read_at, failed_at, updated_at";

export async function listDeliveries(
  announcementId: string,
  opts: { filter?: DeliveryFilter; channel?: Channel | "all"; q?: string; offset?: number; limit?: number } = {},
): Promise<{ rows: DeliveryListRow[]; total: number }> {
  let q = db().from("message_deliveries").select(COLS, { count: "exact" }).eq("announcement_id", announcementId).eq("is_test", false);
  switch (opts.filter) {
    case "pending":
      q = q.in("status", ["queued", "sending"]);
      break;
    case "sent":
      q = q.in("status", ["sent", "delivered", "read"]);
      break;
    case "delivered":
      q = q.in("status", ["delivered", "read"]);
      break;
    case "not_on_whatsapp":
      q = q.eq("channel", "whatsapp").eq("error_code", "131026");
      break;
    case "read":
    case "failed":
    case "bounced":
    case "skipped":
    case "complained":
      q = q.eq("status", opts.filter);
      break;
  }
  if (opts.channel && opts.channel !== "all") q = q.eq("channel", opts.channel);
  if (opts.q) q = q.ilike("recipient_name", `*${opts.q.replace(/[*,()]/g, "")}*`);
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
  const { data, count, error } = await q.order("recipient_name").order("channel").range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as DeliveryListRow[], total: count ?? 0 };
}

export async function allDeliveries(announcementId: string): Promise<DeliveryListRow[]> {
  const out: DeliveryListRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from("message_deliveries").select(COLS).eq("announcement_id", announcementId).eq("is_test", false).order("recipient_name").order("channel").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as DeliveryListRow[]));
    if ((data ?? []).length < 1000) return out;
  }
}

/* ---------------- WhatsApp templates (read-only, cached) ---------------- */

let cache: { at: number; value: { templates: TemplateSpec[]; error: string | null } } | null = null;

export async function whatsappTemplates(force = false): Promise<{ templates: TemplateSpec[]; error: string | null }> {
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return cache.value;
  const cfg = waConfig();
  let value: { templates: TemplateSpec[]; error: string | null };
  if (!cfg || !cfg.wabaId) value = { templates: [], error: "WhatsApp is not configured (WA_CLOUD_ACCESS_TOKEN, WA_CLOUD_PHONE_NUMBER_ID, WA_CLOUD_WABA_ID)" };
  else {
    try {
      value = { templates: await listTemplates(cfg), error: null };
    } catch (err) {
      value = { templates: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

export function statsLine(s: ChannelStats): string {
  return `${s.sent} sent · ${s.delivered} delivered · ${s.failed + s.bounced} failed`;
}
