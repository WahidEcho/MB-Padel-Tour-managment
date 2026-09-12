import MatchStatusBadge from "./MatchStatusBadge";
import ChessBoard from "./ChessBoard";
import {
  currentGame,
  formatMovePairs,
  matchScoreSummary,
  sideToMove,
  type ChessState,
} from "@/lib/chess/engine";
import type { Match, MatchSnapshot, Team } from "@/lib/types";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export default function ChessLiveCard({
  match,
  snapshot,
  teamA,
  teamB,
  boardName,
  big = false,
}: {
  match: Match;
  snapshot: MatchSnapshot | null;
  teamA: Team | undefined;
  teamB: Team | undefined;
  boardName?: string;
  big?: boolean;
}) {
  const live = match.status === "live";
  const state = (snapshot?.snapshot_json as ChessState | null) ?? null;
  const hasState = Boolean(state && state.games);
  const game = hasState ? currentGame(state!) : null;
  const fen = game?.fen ?? START_FEN;

  const whiteSide = game?.whiteSide ?? "A";
  const whiteTeam = whiteSide === "A" ? teamA : teamB;
  const blackTeam = whiteSide === "A" ? teamB : teamA;

  const toMove =
    hasState && !state!.matchOver && game && !game.result ? sideToMove(state!) : null;
  const whiteToMove = toMove !== null && (toMove === "A") === (whiteSide === "A");
  const blackToMove = toMove !== null && !whiteToMove;

  const pairs = game ? formatMovePairs(game.sanHistory) : [];
  const lastPairs = pairs.slice(big ? -12 : -6);
  const winnerTeam =
    match.winner_team_id === teamA?.id ? teamA : match.winner_team_id === teamB?.id ? teamB : null;
  const score = hasState ? matchScoreSummary(state!) : "";

  return (
    <div className={`card space-y-2 ${live ? "border-accent/60" : ""}`}>
      <div className="flex items-center justify-between text-muted">
        <span className={big ? "text-lg font-bold" : "text-xs font-semibold"}>
          {boardName ? `${boardName} · ` : ""}{match.round_name}
        </span>
        <MatchStatusBadge status={match.status} />
      </div>

      {/* Player names with their colour + whose move */}
      <div className="space-y-1">
        <p className={`flex items-center gap-1.5 truncate font-bold ${big ? "text-2xl" : "text-sm"}`}>
          <span className="text-base">○</span>
          <span className="truncate">{whiteTeam?.team_name ?? "TBD"}</span>
          {whiteToMove && <span className="text-accent">▸</span>}
          {winnerTeam && winnerTeam === whiteTeam && " 🏆"}
        </p>
        <p className={`flex items-center gap-1.5 truncate font-bold ${big ? "text-2xl" : "text-sm"}`}>
          <span className="text-base">●</span>
          <span className="truncate">{blackTeam?.team_name ?? "TBD"}</span>
          {blackToMove && <span className="text-accent">▸</span>}
          {winnerTeam && winnerTeam === blackTeam && " 🏆"}
        </p>
      </div>

      {/* Bigger board so moves are readable */}
      <div className={`mx-auto w-full ${big ? "max-w-md" : "max-w-[300px]"}`}>
        <ChessBoard fen={fen} readOnly />
      </div>

      {score && <p className="text-center text-xs text-muted">Score: {score}</p>}

      {/* Last moves */}
      <div className="rounded-lg bg-background p-2">
        <p className={`break-words font-mono leading-relaxed ${big ? "text-base" : "text-xs"}`}>
          {lastPairs.length > 0 ? lastPairs.join("   ") : <span className="text-muted">No moves yet</span>}
        </p>
      </div>
    </div>
  );
}
