import { notFound } from "next/navigation";
import { getBrackets, getMatches, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import { podiumDepthFor } from "@/lib/bracket";
import AutoRefresh from "@/components/AutoRefresh";
import WinnerDisplay, { podiumFromMatches } from "@/components/WinnerDisplay";

export const dynamic = "force-dynamic";

export default async function PublicWinner({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament) notFound();
  const [matches, teams, brackets] = await Promise.all([
    getMatches(tournament.id),
    getTeams(tournament.id),
    getBrackets(tournament.id),
  ]);
  const tm = teamMap(teams);

  // A Cup and a Plate each crown their own champion, so each gets its own
  // podium scoped to its own matches — both tiers produce a match with stage
  // 'final', and an unscoped search would find whichever came back first.
  const podiums = (brackets.length > 0 ? brackets : [null]).map((bracket) => ({
    key: bracket?.id ?? "cup",
    label: bracket?.tier === "plate" ? "Plate" : "Cup",
    podium: podiumFromMatches(matches, tm, {
      tier: bracket?.tier ?? "cup",
      bracketId: bracket?.id ?? undefined,
      depth: podiumDepthFor(tournament.format_config, bracket?.tier ?? "cup"),
    }),
  }));
  const showLabels = podiums.length > 1;

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={10} />
      <h2 className="text-center text-2xl font-bold">{tournament.name} — Final Results</h2>
      {podiums.map(({ key, label, podium }) => (
        <WinnerDisplay key={key} podium={podium} title={showLabels ? label : undefined} />
      ))}
    </div>
  );
}
