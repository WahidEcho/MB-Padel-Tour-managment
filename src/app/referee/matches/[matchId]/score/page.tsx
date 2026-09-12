import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { getCourts, getMatch, getSnapshot, getTeams, getTournament } from "@/lib/data";
import { scoringConfigForMatch } from "@/lib/scoring/rules";
import ScoreClient from "./ScoreClient";
import ChessScoreClient from "./ChessScoreClient";

export const dynamic = "force-dynamic";

export default async function ScorePage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  await requireRole(["referee", "admin", "manager"], `/referee/matches/${matchId}/score`);

  const match = await getMatch(matchId);
  if (!match || !match.team_a_id || !match.team_b_id) notFound();
  const [tournament, teams, courts, snapshot] = await Promise.all([
    getTournament(match.tournament_id),
    getTeams(match.tournament_id),
    getCourts(match.tournament_id),
    getSnapshot(matchId),
  ]);
  if (!tournament) notFound();

  const teamA = teams.find((t) => t.id === match.team_a_id)!;
  const teamB = teams.find((t) => t.id === match.team_b_id)!;
  const court = courts.find((c) => c.id === match.court_id);

  if (tournament.sport === "chess") {
    return (
      <ChessScoreClient
        match={match}
        tournamentName={tournament.name}
        boardName={court?.court_name ?? "No board"}
        legs={tournament.format_config?.legs === 2 ? 2 : 1}
        teamA={{
          id: teamA.id,
          name: teamA.team_name,
          players: teamA.players?.map((p) => ({ name: p.full_name, photo: p })) ?? [],
        }}
        teamB={{
          id: teamB.id,
          name: teamB.team_name,
          players: teamB.players?.map((p) => ({ name: p.full_name, photo: p })) ?? [],
        }}
        serverSnapshot={snapshot}
      />
    );
  }

  return (
    <ScoreClient
      match={match}
      tournamentName={tournament.name}
      courtName={court?.court_name ?? "No court"}
      // The single place a match's rules are resolved. Stage overrides land here,
      // so the referee screen obeys them without any engine change: every engine
      // mutator already takes the config as its last argument.
      scoringConfig={scoringConfigForMatch(tournament, match)}
      teamA={{
        id: teamA.id,
        name: teamA.team_name,
        players: teamA.players?.map((p) => ({ name: p.full_name, photo: p })) ?? [],
        checkedIn: teamA.check_in_status === "checked_in",
      }}
      teamB={{
        id: teamB.id,
        name: teamB.team_name,
        players: teamB.players?.map((p) => ({ name: p.full_name, photo: p })) ?? [],
        checkedIn: teamB.check_in_status === "checked_in",
      }}
      serverSnapshot={snapshot}
    />
  );
}
