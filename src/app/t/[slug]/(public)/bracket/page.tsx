import { notFound } from "next/navigation";
import { getBracket, getBracketSlots, getMatches, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import BracketView from "@/components/BracketView";

export const dynamic = "force-dynamic";

export default async function PublicBracket({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament) notFound();
  const bracket = await getBracket(tournament.id);
  const published = bracket && bracket.status === "published";
  const [slots, matches, teams] = await Promise.all([
    published ? getBracketSlots(bracket.id) : Promise.resolve([]),
    getMatches(tournament.id),
    getTeams(tournament.id),
  ]);

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={8} />
      <h2 className="text-xl font-bold">Knockout bracket</h2>
      {!published ? (
        <p className="card p-8 text-center text-muted">The bracket will appear here once it is published.</p>
      ) : (
        <div className="card">
          <BracketView slots={slots} teams={teamMap(teams)} matches={new Map(matches.map((m) => [m.id, m]))} />
        </div>
      )}
    </div>
  );
}
