import Link from "next/link";
import { listSessions } from "@/lib/friendly/data";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-border text-muted",
  open: "bg-warning/15 text-warning",
  scheduled: "bg-accent/15 text-accent",
  live: "bg-success/15 text-success",
  completed: "bg-accent/15 text-accent",
  finalized: "bg-success/15 text-success",
};

export default async function FriendlySessionsPage() {
  const sessions = await listSessions();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Friendly sessions</h1>
        <Link href="/admin/friendly-sessions/new" className="btn-primary text-sm">
          New session
        </Link>
      </div>
      <p className="text-xs text-muted">
        Casual play sessions with rotating or fixed partners, scored on the same referee screens as
        tournaments and feeding the Season and Lifetime player rankings.
      </p>

      {sessions.length === 0 ? (
        <div className="card space-y-2 p-8 text-center text-muted">
          <p className="font-semibold text-foreground">No sessions yet</p>
          <p className="text-sm">
            Create a session, open registration, then share the link with your players.
          </p>
          <p className="text-sm">
            You may also want to set up{" "}
            <Link href="/admin/seasons" className="font-semibold text-accent">seasons</Link> and{" "}
            <Link href="/admin/players" className="font-semibold text-accent">players</Link> first.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <Link
              key={s.id}
              href={`/admin/friendly-sessions/${s.id}`}
              className="card flex flex-wrap items-center justify-between gap-2 hover:border-accent"
            >
              <div>
                <h2 className="font-bold">
                  {s.name}{" "}
                  <span className={`badge ${STATUS_BADGE[s.status] ?? "bg-border text-muted"}`}>
                    {s.status}
                  </span>
                </h2>
                <p className="text-xs text-muted">
                  {s.starts_at ? new Date(s.starts_at).toLocaleString() : "no start time"} ·{" "}
                  {s.pairing_mode} · {s.duration_minutes} min
                </p>
              </div>
              <span className="text-xs font-semibold text-accent">Manage →</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
