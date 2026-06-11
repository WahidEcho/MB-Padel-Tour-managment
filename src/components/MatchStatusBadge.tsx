const STYLES: Record<string, string> = {
  scheduled: "bg-border text-muted",
  ready: "bg-accent/15 text-accent",
  live: "bg-success/15 text-success",
  paused: "bg-warning/15 text-warning",
  completed: "bg-accent/15 text-accent",
  walkover: "bg-warning/15 text-warning",
  disqualified: "bg-danger/15 text-danger",
  retired: "bg-warning/15 text-warning",
  cancelled: "bg-border text-muted",
  pending_sync: "bg-warning/15 text-warning",
};

export default function MatchStatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STYLES[status] ?? STYLES.scheduled}`}>
      {status === "live" && <span className="pulse-live mr-1">●</span>}
      {status.replace("_", " ")}
    </span>
  );
}
