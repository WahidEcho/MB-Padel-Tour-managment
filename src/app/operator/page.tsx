import Link from "next/link";
import { db } from "@/lib/supabase";
import type { FriendlySession, Tournament } from "@/lib/types";

export const dynamic = "force-dynamic";

const SESSION_BADGE: Record<string, string> = {
  open: "bg-accent/15 text-accent",
  scheduled: "bg-accent/15 text-accent",
  live: "bg-success/15 text-success",
  completed: "bg-border text-muted",
  finalized: "bg-border text-muted",
};

export default async function OperatorIndex() {
  const [tournamentsRes, sessionsRes] = await Promise.all([
    db()
      .from("tournaments")
      .select("*")
      .eq("kind", "tournament")
      .in("status", ["active", "draft", "completed"])
      .order("created_at", { ascending: false }),
    // A session drives a wall exactly like a tournament does: it owns a hidden
    // backing tournament, and the screens hang off that. Without this the
    // operator has no way to reach a session's screen at all.
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
      <h1 className="text-2xl font-bold">Which screens are you driving?</h1>

      <section className="space-y-2">
        <h2 className="label">Tournaments</h2>
        {tournaments.map((t) => (
          <Link
            key={t.id}
            href={`/operator/tournaments/${t.id}/control`}
            className="card flex items-center justify-between hover:border-accent"
          >
            <span className="text-lg font-bold">{t.name}</span>
            <span className="badge bg-border text-muted">{t.status}</span>
          </Link>
        ))}
        {tournaments.length === 0 && <p className="card p-5 text-center text-muted">No tournaments yet.</p>}
      </section>

      {sessions.length > 0 && (
        <section className="space-y-2">
          <h2 className="label">Friendly sessions</h2>
          {sessions.map((s) => (
            <Link
              key={s.id}
              href={`/operator/tournaments/${s.tournament_id}/control`}
              className="card flex items-center justify-between hover:border-accent"
            >
              <span className="text-lg font-bold">{s.name}</span>
              <span className={`badge ${SESSION_BADGE[s.status] ?? "bg-border text-muted"}`}>{s.status}</span>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
