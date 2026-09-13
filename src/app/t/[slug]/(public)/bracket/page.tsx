import { notFound } from "next/navigation";
import { getBrackets, getBracketSlots, getMatches, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import BracketView from "@/components/BracketView";

export const dynamic = "force-dynamic";

export default async function PublicBracket({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament) notFound();
  const brackets = (await getBrackets(tournament.id)).filter((b) => b.status === "published");
  const [slotsByBracket, matches, teams] = await Promise.all([
    Promise.all(brackets.map((b) => getBracketSlots(b.id))),
    getMatches(tournament.id),
    getTeams(tournament.id),
  ]);
  const tm = teamMap(teams);
  const matchMap = new Map(matches.map((m) => [m.id, m]));

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={8} />
      <h2 className="text-xl font-bold">Knockout bracket{brackets.length > 1 ? "s" : ""}</h2>
      {brackets.length === 0 ? (
        <p className="card p-8 text-center text-muted">The bracket will appear here once it is published.</p>
      ) : (
        brackets.map((bracket, i) => (
          <section key={bracket.id} className="space-y-2">
            {brackets.length > 1 && (
              <h3 className="label">{bracket.tier === "plate" ? "Plate" : "Cup"}</h3>
            )}
            <div className="card">
              <BracketView slots={slotsByBracket[i]} teams={tm} matches={matchMap} />
            </div>
          </section>
        ))
      )}
    </div>
  );
}
