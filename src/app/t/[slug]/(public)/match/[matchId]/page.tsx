import { notFound } from "next/navigation";
import { getCourts, getMatch, getSnapshot, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import LiveMatchCard from "@/components/LiveMatchCard";

export const dynamic = "force-dynamic";

export default async function PublicMatch({
  params,
}: {
  params: Promise<{ slug: string; matchId: string }>;
}) {
  const { slug, matchId } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament) notFound();
  const match = await getMatch(matchId);
  if (!match || match.tournament_id !== tournament.id) notFound();
  const [teams, snapshot, courts] = await Promise.all([
    getTeams(tournament.id),
    getSnapshot(matchId),
    getCourts(tournament.id),
  ]);
  const tm = teamMap(teams);
  const courtName = new Map(courts.map((c) => [c.id, c.court_name]));

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <AutoRefresh seconds={4} />
      <LiveMatchCard
        match={match}
        snapshot={snapshot}
        teamA={match.team_a_id ? tm.get(match.team_a_id) : undefined}
        teamB={match.team_b_id ? tm.get(match.team_b_id) : undefined}
        courtName={match.court_id ? courtName.get(match.court_id) : undefined}
        big
      />
    </div>
  );
}
