import { STATUS_LABEL, type ChannelStats, type DeliveryStatus } from "@/lib/messaging/status";

const CHIP: Record<DeliveryStatus, string> = {
  queued: "bg-border text-muted",
  sending: "bg-accent/15 text-accent",
  sent: "bg-accent/15 text-accent",
  delivered: "bg-success/15 text-success",
  read: "bg-success/25 text-success",
  failed: "bg-danger/15 text-danger",
  bounced: "bg-danger/15 text-danger",
  complained: "bg-warning/15 text-warning",
  skipped: "bg-warning/15 text-warning",
};

export function StatusChip({ status, channel, errorCode }: { status: string; channel?: string; errorCode?: string | null }) {
  const s = (status in CHIP ? status : "queued") as DeliveryStatus;
  let label = STATUS_LABEL[s];
  if (s === "failed" && channel === "whatsapp" && errorCode === "131026") label = "Not on WhatsApp";
  if (s === "read" && channel === "email") label = "Opened";
  return <span className={`badge ${CHIP[s]}`}>{label}</span>;
}

const ANN_CHIP: Record<string, string> = {
  draft: "bg-border text-muted",
  sending: "bg-accent/15 text-accent",
  sent: "bg-success/15 text-success",
  cancelled: "bg-warning/15 text-warning",
};

export function AnnouncementStatus({ status }: { status: string }) {
  return <span className={`badge capitalize ${ANN_CHIP[status] ?? ANN_CHIP.draft}`}>{status}</span>;
}

/** The funnel for one channel: sent → delivered → read, and what did not get there. */
export function ChannelFunnel({ label, s, channel }: { label: string; s: ChannelStats; channel: "email" | "whatsapp" }) {
  if (!s.total) return null;
  const cells: [string, number, string][] = [
    ["Recipients", s.total, ""],
    ["Sent", s.sent, "text-accent"],
    ["Delivered", s.delivered, "text-success"],
    [channel === "email" ? "Opened" : "Read", s.read, "text-success"],
    ["Failed", s.failed - (channel === "whatsapp" ? s.notOnWhatsApp : 0), "text-danger"],
    ...(channel === "whatsapp" ? ([["Not on WhatsApp", s.notOnWhatsApp, "text-danger"]] as [string, number, string][]) : []),
    ...(channel === "email" ? ([["Bounced", s.bounced, "text-danger"], ["Spam", s.complained, "text-warning"]] as [string, number, string][]) : []),
    ["Not sent", s.skipped, "text-warning"],
    ["Pending", s.pending, "text-muted"],
  ];
  return (
    <div className="card space-y-2" data-testid={`funnel-${channel}`}>
      <h2 className="label">{label}</h2>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
        {cells.map(([k, v, cls]) => (
          <div key={k} className="rounded-xl border border-border bg-background px-2 py-1.5 text-center">
            <p className={`text-lg font-bold ${cls}`} data-stat={k}>{v}</p>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{k}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
