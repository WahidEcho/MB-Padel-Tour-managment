import Link from "next/link";
import { db } from "@/lib/supabase";
import type { FriendlySession, Tournament } from "@/lib/types";

export const dynamic = "force-dynamic";

const SESSION_BADGE: Record<string, string> = {
  scheduled: "bg-accent/15 text-accent",
  live: "bg-success/15 text-success",
  completed: "bg-border text-muted",
};

export default async function RefereePicker() {
  const [tournamentsRes, sessionsRes] = await Promise.all([
    db()
      .from("tournaments")
      .select("*")
      .eq("kind", "tournament")
      .in("status", ["active", "draft"])
      .order("status", { ascending: true })
      .order("created_at", { ascending: false }),
    // Only sessions with a schedule are worth showing a referee.
    db()
      .from("friendly_sessions")
      .select("*")
      .in("status", ["scheduled", "live", "completed"])
      .order("starts_at", { ascending: false, nullsFirst: false }),
  ]);

  const tournaments = (tournamentsRes.data ?? []) as Tournament[];
  const sessions = (sessionsRes.data ?? []) as FriendlySession[];

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">What are you scoring?</h1>

      <section className="space-y-2">
        <h2 className="label">Tournaments</h2>
        {tournaments.map((t) => (
          <Link
            key={t.id}
            href={`/referee/tournaments/${t.id}/matches`}
            className="card flex items-center justify-between hover:border-accent"
          >
            <span className="text-lg font-bold">{t.name}</span>
            <span
              className={`badge ${t.status === "active" ? "bg-success/15 text-success" : "bg-border text-muted"}`}
            >
              {t.status}
            </span>
          </Link>
        ))}
        {tournaments.length === 0 && (
          <p className="card p-6 text-center text-muted">No tournaments available.</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="label">Friendly sessions</h2>
        {sessions.map((s) => (
          <Link
            key={s.id}
            href={`/referee/friendly-sessions/${s.id}/matches`}
            className="card flex items-center justify-between gap-2 hover:border-accent"
          >
            <div className="min-w-0">
              <p className="truncate text-lg font-bold">{s.name}</p>
              <p className="text-xs text-muted">
                {s.pairing_mode}
                {s.starts_at ? ` · ${new Date(s.starts_at).toLocaleDateString()}` : ""}
              </p>
            </div>
            <span className={`badge ${SESSION_BADGE[s.status] ?? "bg-border text-muted"}`}>{s.status}</span>
          </Link>
        ))}
        {sessions.length === 0 && (
          <p className="card p-6 text-center text-muted">No scheduled sessions.</p>
        )}
      </section>
    </div>
  );
}
