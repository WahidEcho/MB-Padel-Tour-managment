import { publicBracketSlots, publicBrackets, publicCourts, publicMatches, publicTeamRows, publicTies, publicTournamentBySlug } from "@/lib/publicData";
import { notFound } from "next/navigation";
import { teamMap } from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import BracketView from "@/components/BracketView";
import TieBrackets from "@/components/TieBrackets";
import { tournamentAudience } from "@/lib/live/delayServer";
import { maskBracketSlots } from "@/lib/live/delay";

// Rendered at most every 8s and shared by every visitor: at the venue a crowd
// refreshing this page reads one cached copy instead of the database each time.
export const revalidate = 8;

export default async function PublicBracket({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await publicTournamentBySlug(slug);
  if (!tournament) notFound();
  if (tournament.format_config?.ties) return <TieBracketPage tournamentId={tournament.id} tournament={tournament} />;
  const brackets = (await publicBrackets(tournament.id)).filter((b) => b.status === "published");
  const [storedSlots, allMatches, teams] = await Promise.all([
    Promise.all(brackets.map((b) => publicBracketSlots(b.id))),
    publicMatches(tournament.id),
    publicTeamRows(tournament.id),
  ]);
  // The audience delay: a result inside its window has not advanced anyone yet.
  const { matches, hidden } = await tournamentAudience(tournament, { matches: allMatches });
  const slotsByBracket = storedSlots.map((slots) => maskBracketSlots(slots, hidden));
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

/** A nations event: its placement draws (Cup, Plate) as brackets, as the audience sees them. */
async function TieBracketPage({ tournamentId, tournament }: { tournamentId: string; tournament: NonNullable<Awaited<ReturnType<typeof publicTournamentBySlug>>> }) {
  const [allTies, allMatches, teams, courts] = await Promise.all([publicTies(tournamentId), publicMatches(tournamentId), publicTeamRows(tournamentId), publicCourts(tournamentId)]);
  // The audience delay: a tie decided inside its window has not sent anyone on yet.
  const { ties } = await tournamentAudience(tournament, { matches: allMatches, ties: allTies });
  return (
    <div className="space-y-4">
      <AutoRefresh seconds={8} />
      <h2 className="text-xl font-bold">Play-off brackets</h2>
      <TieBrackets ties={ties} teams={teamMap(teams)} courts={new Map(courts.map((c) => [c.id, c.court_name]))} timeZone={tournament.timezone || "Africa/Cairo"} />
    </div>
  );
}
