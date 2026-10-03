/**
 * Delivery statuses and how they may change. Pure module.
 *
 * Providers do not promise ordering (Meta retries webhooks for days; Resend may
 * report "delivered" before our own "sent" write lands), so a status only ever
 * moves forward. Failures rank highest: once a message failed, bounced or drew a
 * complaint, a late "sent" must never hide it.
 */

export type Channel = "email" | "whatsapp";
export const CHANNELS: Channel[] = ["email", "whatsapp"];

export type DeliveryStatus =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "bounced"
  | "complained"
  | "skipped";

export const STATUS_RANK: Record<DeliveryStatus, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  // Terminal outcomes.
  failed: 5,
  bounced: 5,
  complained: 6,
  skipped: 7,
};

/** May a delivery at `from` be moved to `to` by a provider report? */
export function canAdvance(from: DeliveryStatus, to: DeliveryStatus): boolean {
  if (from === "skipped") return false;
  // A complaint arrives after delivery; it is the one change allowed after a failure rank.
  if (to === "complained") return from !== "complained";
  return STATUS_RANK[to] > STATUS_RANK[from];
}

/** The timestamp column a status sets, if any. */
export function timestampFor(status: DeliveryStatus): "sent_at" | "delivered_at" | "read_at" | "failed_at" | null {
  switch (status) {
    case "sent":
      return "sent_at";
    case "delivered":
      return "delivered_at";
    case "read":
      return "read_at";
    case "failed":
    case "bounced":
    case "complained":
      return "failed_at";
    default:
      return null;
  }
}

export interface StatRow {
  channel: Channel;
  status: DeliveryStatus;
  not_on_whatsapp: boolean | null;
  n: number;
}

export interface ChannelStats {
  total: number;
  pending: number;
  /** Accepted by the provider (sent or better). */
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  bounced: number;
  complained: number;
  skipped: number;
  notOnWhatsApp: number;
}

export function emptyStats(): ChannelStats {
  return { total: 0, pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, bounced: 0, complained: 0, skipped: 0, notOnWhatsApp: 0 };
}

/**
 * Folds grouped counts into per-channel figures. "Sent" counts everything the
 * provider accepted (so delivered and read are inside it), "delivered" includes
 * read, matching how people read a funnel.
 */
export function summarize(rows: StatRow[]): Record<Channel, ChannelStats> & { all: ChannelStats } {
  const out = { email: emptyStats(), whatsapp: emptyStats(), all: emptyStats() };
  for (const r of rows) {
    for (const s of [out[r.channel], out.all]) {
      if (!s) continue;
      s.total += r.n;
      switch (r.status) {
        case "queued":
        case "sending":
          s.pending += r.n;
          break;
        case "sent":
          s.sent += r.n;
          break;
        case "delivered":
          s.sent += r.n;
          s.delivered += r.n;
          break;
        case "read":
          s.sent += r.n;
          s.delivered += r.n;
          s.read += r.n;
          break;
        case "failed":
          s.failed += r.n;
          if (r.not_on_whatsapp) s.notOnWhatsApp += r.n;
          break;
        case "bounced":
          s.bounced += r.n;
          break;
        case "complained":
          // A complaint means it was delivered first.
          s.sent += r.n;
          s.delivered += r.n;
          s.complained += r.n;
          break;
        case "skipped":
          s.skipped += r.n;
          break;
      }
    }
  }
  return out;
}

export const STATUS_LABEL: Record<DeliveryStatus, string> = {
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  bounced: "Bounced",
  complained: "Marked as spam",
  skipped: "Not sent",
};
