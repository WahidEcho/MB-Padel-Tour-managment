import { currentRole, can } from "@/lib/auth";
import { allDeliveries, getAnnouncement } from "@/lib/messaging/data";
import { STATUS_LABEL, type DeliveryStatus } from "@/lib/messaging/status";

function cell(v: unknown): string {
  const s = v == null ? "" : String(v);
  // Quote everything; neutralise spreadsheet formulas.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Every recipient of an announcement and what happened, as CSV. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!can(await currentRole(), "send_messages")) return new Response("Not allowed", { status: 403 });
  const { id } = await ctx.params;
  const a = await getAnnouncement(id);
  if (!a) return new Response("Not found", { status: 404 });
  const rows = await allDeliveries(id);
  const head = ["name", "channel", "address", "status", "reason", "error_code", "attempts", "sent_at", "delivered_at", "read_at", "failed_at", "recipient_kind", "recipient_id", "provider_message_id"];
  const lines = [head.join(",")];
  for (const r of rows) {
    const label = r.status === "failed" && r.error_code === "131026" ? "Not on WhatsApp" : STATUS_LABEL[r.status as DeliveryStatus] ?? r.status;
    lines.push(
      [r.recipient_name, r.channel, r.address, label, r.error_reason, r.error_code, r.attempts, r.sent_at, r.delivered_at, r.read_at, r.failed_at, r.recipient_kind, r.recipient_id, r.provider_message_id]
        .map(cell)
        .join(","),
    );
  }
  const name = a.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60).toLowerCase() || "announcement";
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-deliveries.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
