import { Chess } from "chess.js";

/**
 * Pure chess match logic (framework-free, fully serializable state).
 *
 * A chess "match" is a knockout pairing of 1 or 2 games. Side "A" is the
 * tournament team_a (White in game 1); for 2-leg matches the colours reverse in
 * game 2 so each player has White once. The shared finalize contract with the
 * scoring/sync pipeline is the same as padel: when `matchOver && winner` are set
 * the events route completes the match and advances the bracket.
 */

export type Side = "A" | "B";
export type Color = "white" | "black";
export type GameResult = "white" | "black" | "draw" | null; // null = in progress
export type EndReason =
  | "checkmate"
  | "stalemate"
  | "draw"
  | "resignation"
  | "timeout"
  | null;

export interface ChessGame {
  fen: string;
  sanHistory: string[];
  whiteSide: Side; // which player holds the white pieces this game
  result: GameResult;
  endReason: EndReason;
}

export interface ChessState {
  legs: 1 | 2;
  games: ChessGame[]; // index 0..legs-1; later games created as needed
  currentGameIndex: number;
  scoreA: number; // match points (win = 1, draw = 0.5)
  scoreB: number;
  needsArbiter: boolean; // tie that requires a manual "decide winner"
  // Shared finalize contract (mirrors padel ScoreState):
  winner: Side | null;
  matchOver: boolean;
  servingTeam: null; // unused for chess; keeps the snapshot/route contract happy
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function clone(state: ChessState): ChessState {
  return JSON.parse(JSON.stringify(state)) as ChessState;
}

function newGame(whiteSide: Side): ChessGame {
  return { fen: START_FEN, sanHistory: [], whiteSide, result: null, endReason: null };
}

export function newChessState(legs: 1 | 2 = 1): ChessState {
  return {
    legs,
    games: [newGame("A")],
    currentGameIndex: 0,
    scoreA: 0,
    scoreB: 0,
    needsArbiter: false,
    winner: null,
    matchOver: false,
    servingTeam: null,
  };
}

export function currentGame(state: ChessState): ChessGame {
  return state.games[state.currentGameIndex];
}

/** Whose turn it is in the current game, as a player side ("A"/"B"). */
export function sideToMove(state: ChessState): Side {
  const g = currentGame(state);
  const turn = new Chess(g.fen).turn(); // "w" | "b"
  const whiteIsA = g.whiteSide === "A";
  if (turn === "w") return whiteIsA ? "A" : "B";
  return whiteIsA ? "B" : "A";
}

export interface LegalMove {
  to: string;
  promotion?: boolean; // true if this move requires choosing a promotion piece
}

/** Legal destination squares for the piece on `square` in the current game. */
export function legalMovesFrom(state: ChessState, square: string): LegalMove[] {
  const g = currentGame(state);
  if (g.result) return [];
  const chess = new Chess(g.fen);
  const verbose = chess.moves({ square: square as never, verbose: true }) as Array<{
    to: string;
    promotion?: string;
  }>;
  const seen = new Map<string, LegalMove>();
  for (const m of verbose) {
    const existing = seen.get(m.to);
    if (existing) {
      if (m.promotion) existing.promotion = true;
    } else {
      seen.set(m.to, { to: m.to, promotion: Boolean(m.promotion) });
    }
  }
  return [...seen.values()];
}

function settleGameEnd(state: ChessState): ChessState {
  const g = currentGame(state);
  if (!g.result) return state;

  // Award match points for the finished game.
  if (g.result === "draw") {
    state.scoreA += 0.5;
    state.scoreB += 0.5;
  } else {
    const winnerSide: Side = g.result === "white" ? g.whiteSide : g.whiteSide === "A" ? "B" : "A";
    if (winnerSide === "A") state.scoreA += 1;
    else state.scoreB += 1;
  }

  const playedGames = state.currentGameIndex + 1;
  if (playedGames < state.legs) {
    // Start the next leg with colours reversed.
    const prevWhite = g.whiteSide;
    state.games.push(newGame(prevWhite === "A" ? "B" : "A"));
    state.currentGameIndex += 1;
    return state;
  }

  // All legs played — decide the match.
  if (state.scoreA > state.scoreB) {
    state.winner = "A";
    state.matchOver = true;
  } else if (state.scoreB > state.scoreA) {
    state.winner = "B";
    state.matchOver = true;
  } else {
    state.needsArbiter = true; // tie → arbiter must pick who advances
  }
  return state;
}

export interface ApplyMoveResult {
  state: ChessState;
  san: string | null; // null if the move was illegal (state unchanged)
}

export function applyMove(
  prev: ChessState,
  from: string,
  to: string,
  promotion?: "q" | "r" | "b" | "n"
): ApplyMoveResult {
  if (prev.matchOver) return { state: prev, san: null };
  const state = clone(prev);
  const g = currentGame(state);
  if (g.result) return { state: prev, san: null };

  const chess = new Chess(g.fen);
  let move;
  try {
    move = chess.move({ from, to, promotion: promotion ?? "q" });
  } catch {
    return { state: prev, san: null };
  }
  if (!move) return { state: prev, san: null };

  g.sanHistory.push(move.san);
  g.fen = chess.fen();

  if (chess.isCheckmate()) {
    g.result = chess.turn() === "w" ? "black" : "white"; // side that just moved won
    g.endReason = "checkmate";
    settleGameEnd(state);
  } else if (chess.isStalemate()) {
    g.result = "draw";
    g.endReason = "stalemate";
    settleGameEnd(state);
  } else if (chess.isDraw() || chess.isInsufficientMaterial() || chess.isThreefoldRepetition()) {
    g.result = "draw";
    g.endReason = "draw";
    settleGameEnd(state);
  }

  return { state, san: move.san };
}

/** A player resigns the current game. */
export function resign(prev: ChessState, side: Side): ChessState {
  if (prev.matchOver) return prev;
  const state = clone(prev);
  const g = currentGame(state);
  if (g.result) return prev;
  const loserIsWhite = g.whiteSide === side;
  g.result = loserIsWhite ? "black" : "white";
  g.endReason = "resignation";
  return settleGameEnd(state);
}

/** Players agree to a draw in the current game. */
export function declareDraw(prev: ChessState): ChessState {
  if (prev.matchOver) return prev;
  const state = clone(prev);
  const g = currentGame(state);
  if (g.result) return prev;
  g.result = "draw";
  g.endReason = "draw";
  return settleGameEnd(state);
}

/** Arbiter manually decides who advances (after a draw / 1-1 tie). */
export function decideWinner(prev: ChessState, side: Side): ChessState {
  const state = clone(prev);
  state.winner = side;
  state.matchOver = true;
  state.needsArbiter = false;
  return state;
}

export function inCheck(state: ChessState): boolean {
  const g = currentGame(state);
  return new Chess(g.fen).inCheck();
}

/** Total moves across the whole match (all games). */
export function totalMoves(state: ChessState): number {
  return state.games.reduce((n, g) => n + g.sanHistory.length, 0);
}

/** SAN history formatted as numbered pairs, e.g. ["1. e4 e5", "2. Nf3 Nc6"]. */
export function formatMovePairs(sanHistory: string[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < sanHistory.length; i += 2) {
    const no = i / 2 + 1;
    const white = sanHistory[i];
    const black = sanHistory[i + 1];
    pairs.push(`${no}. ${white}${black ? ` ${black}` : ""}`);
  }
  return pairs;
}

/** Player-A vs player-B match score, e.g. "1 - 0" or "½ - ½". */
export function matchScoreSummary(state: ChessState): string {
  const fmt = (n: number) => (n % 1 === 0.5 ? `${Math.floor(n)}½`.replace("0½", "½") : String(n));
  if (state.scoreA === 0 && state.scoreB === 0) return "";
  return `${fmt(state.scoreA)} - ${fmt(state.scoreB)}`;
}
