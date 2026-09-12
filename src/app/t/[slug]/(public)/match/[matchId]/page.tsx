import { notFound } from "next/navigation";
import { getCourts, getMatch, getSnapshot, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import LiveMatchCard from "@/components/LiveMatchCard";
import ChessTheater from "@/components/ChessTheater";
// ChessLiveCard is used elsewhere (live/overview/TV); the match page uses the theater view.
import {
  currentGame,
  formatMovePairs,
  inCheck as chessInCheck,
  matchScoreSummary,
  sideToMove,
  type ChessState,
} from "@/lib/chess/engine";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

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

  const teamA = match.team_a_id ? tm.get(match.team_a_id) : undefined;
  const teamB = match.team_b_id ? tm.get(match.team_b_id) : undefined;

  if (tournament.sport === "chess") {
    const state = (snapshot?.snapshot_json as ChessState | null) ?? null;
    const hasState = Boolean(state && state.games);
    const game = hasState ? currentGame(state!) : null;
    const whiteSide = game?.whiteSide ?? "A";
    const whiteName = (whiteSide === "A" ? teamA : teamB)?.team_name ?? "TBD";
    const blackName = (whiteSide === "A" ? teamB : teamA)?.team_name ?? "TBD";
    const toMoveSide =
      hasState && !state!.matchOver && game && !game.result ? sideToMove(state!) : null;
    const toMove = toMoveSide ? ((toMoveSide === "A") === (whiteSide === "A") ? "white" : "black") : null;
    const winnerColor =
      match.winner_team_id && hasState
        ? match.winner_team_id === (whiteSide === "A" ? teamA?.id : teamB?.id)
          ? "white"
          : "black"
        : null;
    const board = match.court_id ? courtName.get(match.court_id) : undefined;

    return (
      <div className="mx-auto max-w-3xl">
        <AutoRefresh seconds={4} />
        <ChessTheater
          fen={game?.fen ?? START_FEN}
          movePairs={game ? formatMovePairs(game.sanHistory) : []}
          whiteName={whiteName}
          blackName={blackName}
          toMove={toMove}
          inCheck={hasState ? chessInCheck(state!) : false}
          winnerColor={winnerColor}
          score={hasState ? matchScoreSummary(state!) : ""}
          heading={`${board ? `${board} · ` : ""}${match.round_name ?? ""}`}
          status={match.status}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <AutoRefresh seconds={4} />
      <LiveMatchCard
        match={match}
        snapshot={snapshot}
        teamA={teamA}
        teamB={teamB}
        courtName={match.court_id ? courtName.get(match.court_id) : undefined}
        big
      />
    </div>
  );
}
