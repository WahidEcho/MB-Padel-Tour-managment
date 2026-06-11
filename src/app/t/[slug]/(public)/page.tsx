import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getCourts,
  getGroups,
  getMatches,
  getSnapshots,
  getStandings,
  getTeams,
  getTournamentBySlug,
  teamMap,
} from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import LiveMatchCard from "@/components/LiveMatchCard";
import StandingsTable from "@/components/StandingsTable";

export const dynamic = "force-dynamic";

export default async function PublicOverview({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament) notFound();
  const id = tournament.id;
  const [groups, standings, teams, matches, snapshots, courts] = await Promise.all([
    getGroups(id),
    getStandings(id),
    getTeams(id),
    getMatches(id),
    getSnapshots(id),
    getCourts(id),
  ]);
  const tm = teamMap(teams);
  const snapByMatch = new Map(snapshots.map((s) => [s.match_id, s]));
  const courtName = new Map(courts.map((c) => [c.id, c.court_name]));
  const live = matches.filter((m) => ["live", "paused"].includes(m.status));
  const upcoming = matches.filter((m) => ["scheduled", "ready"].includes(m.status)).slice(0, 8);

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={8} />

      {live.length > 0 && (
        <section className="space-y-2">
          <h2 className="label">Live now</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {live.map((m) => (
              <Link key={m.id} href={`/t/${slug}/match/${m.id}`}>
                <LiveMatchCard
                  match={m}
                  snapshot={snapByMatch.get(m.id) ?? null}
                  teamA={m.team_a_id ? tm.get(m.team_a_id) : undefined}
                  teamB={m.team_b_id ? tm.get(m.team_b_id) : undefined}
                  courtName={m.court_id ? courtName.get(m.court_id) : undefined}
                />
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="label">Groups</h2>
        {groups.length === 0 && <p className="card p-6 text-center text-muted">Groups coming soon.</p>}
        <div className="grid gap-3 md:grid-cols-2">
          {groups.map((g) => (
            <div key={g.id} className="card overflow-x-auto">
              <h3 className="mb-1 font-bold">{g.group_name}</h3>
              <StandingsTable standings={standings.filter((s) => s.group_id === g.id)} teams={tm} compact />
            </div>
          ))}
        </div>
      </section>

      {upcoming.length > 0 && (
        <section className="space-y-2">
          <h2 className="label">Upcoming matches</h2>
          <ul className="space-y-1.5">
            {upcoming.map((m) => (
              <li key={m.id} className="card flex items-center justify-between py-2 text-sm">
                <span className="font-semibold">
                  {m.team_a_id ? tm.get(m.team_a_id)?.team_name : "TBD"}{" "}
                  <span className="text-muted">vs</span>{" "}
                  {m.team_b_id ? tm.get(m.team_b_id)?.team_name : "TBD"}
                </span>
                <span className="text-xs text-muted">
                  #{m.match_order} · {m.round_name}
                  {m.court_id ? ` · ${courtName.get(m.court_id)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
