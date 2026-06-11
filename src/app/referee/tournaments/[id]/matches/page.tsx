import Link from "next/link";
import { notFound } from "next/navigation";
import { getCourts, getMatches, getTeams, getTournament, teamMap } from "@/lib/data";
import MatchStatusBadge from "@/components/MatchStatusBadge";
import AutoRefresh from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

export default async function RefereeMatches({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const [matches, teams, courts] = await Promise.all([getMatches(id), getTeams(id), getCourts(id)]);
  const tm = teamMap(teams);
  const courtName = new Map(courts.map((c) => [c.id, c.court_name]));

  const open = matches.filter((m) => !["completed", "walkover", "disqualified", "retired", "cancelled"].includes(m.status));
  const finished = matches.filter((m) => ["completed", "walkover", "disqualified", "retired"].includes(m.status));

  function teamLabel(teamId: string | null) {
    if (!teamId) return "TBD";
    const t = tm.get(teamId);
    if (!t) return "?";
    const notIn = t.check_in_status !== "checked_in";
    return `${t.team_name}${notIn ? " ⚠" : ""}`;
  }

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={10} />
      <h1 className="text-xl font-bold">{tournament.name} — matches</h1>
      <p className="text-xs text-muted">⚠ = team not checked in yet. You can still start the match (override warning shown).</p>

      <section className="space-y-2">
        <h2 className="label">Upcoming &amp; live</h2>
        {open.map((m) => (
          <Link
            key={m.id}
            href={`/referee/matches/${m.id}/score`}
            className="card flex items-center justify-between gap-2 hover:border-accent"
          >
            <div>
              <p className="text-xs text-muted">
                #{m.match_order} · {m.round_name} · {m.court_id ? courtName.get(m.court_id) : "no court"}
              </p>
              <p className="text-lg font-bold">
                {teamLabel(m.team_a_id)} <span className="text-muted">vs</span> {teamLabel(m.team_b_id)}
              </p>
            </div>
            <MatchStatusBadge status={m.status} />
          </Link>
        ))}
        {open.length === 0 && <p className="card p-6 text-center text-muted">No open matches.</p>}
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
              <p className="text-sm font-semibold">
                {teamLabel(m.team_a_id)} vs {teamLabel(m.team_b_id)}
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
