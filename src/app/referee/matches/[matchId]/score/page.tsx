import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { getCourts, getMatch, getSnapshot, getTeams, getTournament } from "@/lib/data";
import { DEFAULT_SCORING_CONFIG } from "@/lib/types";
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
          players: teamA.players?.map((p) => ({ name: p.full_name, photo: p.photo_url })) ?? [],
        }}
        teamB={{
          id: teamB.id,
          name: teamB.team_name,
          players: teamB.players?.map((p) => ({ name: p.full_name, photo: p.photo_url })) ?? [],
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
      scoringConfig={{ ...DEFAULT_SCORING_CONFIG, ...tournament.scoring_config }}
      teamA={{
        id: teamA.id,
        name: teamA.team_name,
        players: teamA.players?.map((p) => ({ name: p.full_name, photo: p.photo_url })) ?? [],
        checkedIn: teamA.check_in_status === "checked_in",
      }}
      teamB={{
        id: teamB.id,
        name: teamB.team_name,
        players: teamB.players?.map((p) => ({ name: p.full_name, photo: p.photo_url })) ?? [],
        checkedIn: teamB.check_in_status === "checked_in",
      }}
      serverSnapshot={snapshot}
    />
  );
}
