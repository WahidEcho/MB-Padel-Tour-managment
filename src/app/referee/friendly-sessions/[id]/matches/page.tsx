import Link from "next/link";
import { notFound } from "next/navigation";
import { getCourts, getMatches, getTeams, teamMap } from "@/lib/data";
import { getSession } from "@/lib/friendly/data";
import MatchStatusBadge from "@/components/MatchStatusBadge";
import AutoRefresh from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

/**
 * Referee view for a friendly session.
 * Friendly matches are ordinary `matches` rows, so the per-match scoring screen
 * at /referee/matches/[matchId]/score is reused unchanged — this page only
 * needs to list them.
 */
export default async function RefereeSessionMatches({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) notFound();

  const [matches, teams, courts] = await Promise.all([
    getMatches(session.tournament_id),
    getTeams(session.tournament_id),
    getCourts(session.tournament_id),
  ]);
  const tm = teamMap(teams);
  const courtName = new Map(courts.map((c) => [c.id, c.court_name]));

  const friendly = matches.filter((m) => m.stage === "friendly");
  const open = friendly.filter(
    (m) => !["completed", "walkover", "disqualified", "retired", "cancelled"].includes(m.status)
  );
  const finished = friendly.filter((m) =>
    ["completed", "walkover", "disqualified", "retired"].includes(m.status)
  );

  const label = (teamId: string | null) => (teamId ? (tm.get(teamId)?.team_name ?? "?") : "TBD");

  // Rounds run in order; the earliest unfinished round is what's on court now.
  const currentRound = open[0]?.round_name ?? null;

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={10} />
      <div>
        <h1 className="text-xl font-bold">{session.name}</h1>
        <p className="text-xs text-muted">
          Friendly session · {session.pairing_mode}
          {currentRound ? ` · now on ${currentRound}` : ""}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="label">Upcoming &amp; live</h2>
        {open.map((m) => (
          <Link
            key={m.id}
            href={`/referee/matches/${m.id}/score`}
            className="card flex items-center justify-between gap-2 hover:border-accent"
          >
            <div className="min-w-0">
              <p className="text-xs text-muted">
                {m.round_name} · {m.court_id ? courtName.get(m.court_id) : "no court"}
              </p>
              <p className="truncate text-lg font-bold">{label(m.team_a_id)}</p>
              <p className="truncate text-sm text-muted">v {label(m.team_b_id)}</p>
            </div>
            <MatchStatusBadge status={m.status} />
          </Link>
        ))}
        {open.length === 0 && (
          <p className="card p-6 text-center text-muted">
            {friendly.length === 0
              ? "No matches scheduled yet."
              : "All matches finished."}
          </p>
        )}
      </section>

      {finished.length > 0 && (
        <section className="space-y-2">
          <h2 className="label">Finished</h2>
          {finished.map((m) => (
            <Link
              key={m.id}
              href={`/referee/matches/${m.id}/score`}
              className="card flex items-center justify-between gap-2 opacity-70 hover:opacity-100"
            >
              <p className="min-w-0 truncate text-sm font-semibold">
                {label(m.team_a_id)} v {label(m.team_b_id)}
                <span className="ml-2 text-xs text-muted">{m.round_name}</span>
              </p>
              <MatchStatusBadge status={m.status} />
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
