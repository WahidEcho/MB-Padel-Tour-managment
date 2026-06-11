import { notFound } from "next/navigation";
import { getMatches, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import WinnerDisplay, { podiumFromMatches } from "@/components/WinnerDisplay";

export const dynamic = "force-dynamic";

export default async function PublicWinner({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament) notFound();
  const [matches, teams] = await Promise.all([getMatches(tournament.id), getTeams(tournament.id)]);
  const podium = podiumFromMatches(matches, teamMap(teams));

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={10} />
      <h2 className="text-center text-2xl font-bold">{tournament.name} — Final Results</h2>
      <WinnerDisplay podium={podium} />
    </div>
  );
}
