import { notFound } from "next/navigation";
import { getGroups, getStandings, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import StandingsTable from "@/components/StandingsTable";

export const dynamic = "force-dynamic";

export default async function PublicLeaderboard({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament) notFound();
  const [groups, standings, teams] = await Promise.all([
    getGroups(tournament.id),
    getStandings(tournament.id),
    getTeams(tournament.id),
  ]);
  const tm = teamMap(teams);

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={8} />
      <h2 className="text-xl font-bold">Leaderboard</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((g) => (
          <div key={g.id} className="card overflow-x-auto">
            <h3 className="mb-2 font-bold">{g.group_name}</h3>
            <StandingsTable standings={standings.filter((s) => s.group_id === g.id)} teams={tm} />
          </div>
        ))}
        {groups.length === 0 && <p className="card p-8 text-center text-muted">No groups yet.</p>}
      </div>
    </div>
  );
}
