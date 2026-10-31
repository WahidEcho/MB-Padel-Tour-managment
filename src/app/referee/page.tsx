import Link from "next/link";
import { db } from "@/lib/supabase";
import { requireStaff } from "@/lib/guard";
import { orgTournamentIds } from "@/lib/orgs/scope";
import type { FriendlySession, Tournament } from "@/lib/types";
import CourtList from "./CourtList";
import { callMasterEnabled } from "@/lib/referees/assistance";

export const dynamic = "force-dynamic";

const SESSION_BADGE: Record<string, string> = {
  scheduled: "bg-accent/15 text-accent",
  live: "bg-success/15 text-success",
  completed: "bg-border text-muted",
};

async function codeLabel(codeId: string | null, orgId: string): Promise<string | null> {
  if (!codeId) return null;
  const { data } = await db().from("organization_codes").select("label").eq("id", codeId).eq("organization_id", orgId).maybeSingle();
  return (data as { label: string | null } | null)?.label ?? null;
}

export default async function RefereePicker() {
  const staff = await requireStaff(["referee", "admin", "manager"], "/referee");
  // A chair umpire code (migration 0034): today's matches on its court, nothing else.
  if (staff.scopeCourt) return <CourtList scope={staff.scopeCourt} label={await codeLabel(staff.codeId, staff.orgId)} assistance={Boolean(staff.referee) && (await callMasterEnabled(staff))} />;
  // This organisation's only, and only the one tournament an event code is scoped to.
  let tq = db()
    .from("tournaments")
    .select("*")
    .eq("organization_id", staff.orgId)
    .eq("kind", "tournament")
    .in("status", ["active", "draft"]);
  if (staff.scopeTournamentId) tq = tq.eq("id", staff.scopeTournamentId);
  // A master referee (migration 0035): its events only, and no friendly sessions.
  if (staff.scopeTournamentIds) tq = tq.in("id", staff.scopeTournamentIds.length ? staff.scopeTournamentIds : ["00000000-0000-4000-8000-000000000000"]);
  const sessionTournaments = staff.scopeTournamentIds
    ? []
    : (await orgTournamentIds(staff.orgId, ["friendly_session"])).filter((id) => !staff.scopeTournamentId || id === staff.scopeTournamentId);
  const [tournamentsRes, sessionsRes] = await Promise.all([
    tq.order("status", { ascending: true }).order("created_at", { ascending: false }),
    // Only sessions with a schedule are worth showing a referee.
    sessionTournaments.length === 0
      ? Promise.resolve({ data: [] as FriendlySession[] })
      : db()
      .from("friendly_sessions")
      .select("*")
      .in("tournament_id", sessionTournaments.slice(0, 500))
      .in("status", ["scheduled", "live", "completed"])
      .order("starts_at", { ascending: false, nullsFirst: false }),
  ]);

  const tournaments = (tournamentsRes.data ?? []) as Tournament[];
  const master = staff.referee?.role === "master_referee";
  const sessions = (sessionsRes.data ?? []) as FriendlySession[];

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">What are you scoring?</h1>
      {master && (
        <Link href="/referee/master" className="card flex items-center justify-between border-accent/60 hover:border-accent" data-testid="master-home">
          <span>
            <span className="block text-lg font-bold">Master referee: calls &amp; courts</span>
            <span className="text-xs text-muted">Every court of {tournaments.length === 1 ? "the event" : "your events"}: open calls for assistance, any court&apos;s matches, the match desk.</span>
          </span>
          <span className="text-accent">→</span>
        </Link>
      )}

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
