/**
 * Chess results entered as win / draw / loss (Phase 2): no moves, no board.
 *
 * How a game counts depends on the competition:
 *   group, Swiss, league   win 1, draw ½ each, loss 0; a draw is a finished result.
 *   knockout               the pairing must produce someone who advances. A
 *                          pairing level after its games (a one-game draw, or 1-1
 *                          over two legs) is NOT decided here: the organiser picks
 *                          who advances (`decideWinner` in engine.ts, which the
 *                          referee console already calls the arbiter's decision).
 *
 * The state built here has the same shape as engine.ts's `ChessState`, so the
 * snapshot writer, the events route and the screens treat an entered result like
 * a game played on the board. Deliberately free of chess.js (engine.ts imports
 * it), so the Move Score app can share this file through src/core/index.ts.
 */

/** A side of the pairing: "A" is the tournament's team_a (White in game 1). Same as engine.ts. */
export type Side = "A" | "B";

/**
 * engine.ts's `ChessGame` / `ChessState`, restated so this file does not reach
 * engine.ts (and chess.js) in the app; result.test.ts checks they stay assignable.
 */
export interface ChessGame {
  fen: string;
  sanHistory: string[];
  whiteSide: Side;
  result: "white" | "black" | "draw" | null;
  endReason: "checkmate" | "stalemate" | "draw" | "resignation" | "timeout" | null;
}

export interface ChessState {
  legs: 1 | 2;
  games: ChessGame[];
  currentGameIndex: number;
  scoreA: number;
  scoreB: number;
  needsArbiter: boolean;
  winner: Side | null;
  matchOver: boolean;
  servingTeam: null;
}

/** Who won one game: a side, or a draw. */
export type ChessGameResult = Side | "draw";

/** Where the game is played: decides what a draw means. */
export type ChessCompetition = "group" | "swiss" | "league" | "knockout";

/** The starting position, as engine.ts starts every game. */
export const CHESS_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Points each side takes for one game: 1 / ½ / 0. */
export function chessGamePoints(result: ChessGameResult): { a: number; b: number } {
  if (result === "draw") return { a: 0.5, b: 0.5 };
  return result === "A" ? { a: 1, b: 0 } : { a: 0, b: 1 };
}

export type ChessAdvance = Side | "organiser_decides" | null;

export interface ChessOutcome {
  /** Match points over the pairing's games (sums of 1 / ½ / 0). */
  points: { a: number; b: number };
  /** The side that won the pairing on points; null when level. */
  winner: Side | null;
  /** Group, Swiss and league: a level pairing is a drawn, finished result. */
  draw: boolean;
  /**
   * Knockout only: who goes through. "organiser_decides" when the pairing is
   * level, so the organiser is asked who advances. Null outside a knockout.
   */
  advance: ChessAdvance;
}

/** What a pairing's game results come to in a competition. */
export function chessOutcome(games: ChessGameResult[], competition: ChessCompetition): ChessOutcome {
  let a = 0;
  let b = 0;
  for (const g of games) {
    const p = chessGamePoints(g);
    a += p.a;
    b += p.b;
  }
  const winner: Side | null = a > b ? "A" : b > a ? "B" : null;
  if (competition === "knockout") {
    return { points: { a, b }, winner, draw: false, advance: winner ?? "organiser_decides" };
  }
  return { points: { a, b }, winner, draw: winner === null, advance: null };
}

export type ChessResultProblemCode = "no_games" | "wrong_game_count" | "not_a_result";

export interface ChessResultProblem {
  code: ChessResultProblemCode;
  message: string;
}

/** Problems with entered results for a pairing of `legs` games; empty when fine. */
export function validateChessResults(games: unknown[], legs: 1 | 2 = 1): ChessResultProblem[] {
  if (!Array.isArray(games) || games.length === 0) return [{ code: "no_games", message: "Enter the result of the game." }];
  if (games.length !== legs) {
    return [{ code: "wrong_game_count", message: `This pairing is ${legs} game${legs === 1 ? "" : "s"}: enter ${legs === 1 ? "one result" : "both results"}.` }];
  }
  if (games.some((g) => g !== "A" && g !== "B" && g !== "draw")) {
    return [{ code: "not_a_result", message: "Each game is a win for one side or a draw." }];
  }
  return [];
}

function enteredGame(whiteSide: Side, result: ChessGameResult): ChessGame {
  const whiteWon = result !== "draw" && result === whiteSide;
  return {
    fen: CHESS_START_FEN,
    sanHistory: [],
    whiteSide,
    result: result === "draw" ? "draw" : whiteWon ? "white" : "black",
    // engine.ts has no reason for an entered result; "draw" / "resignation" are the
    // closest neutral words its screens already know.
    endReason: result === "draw" ? "draw" : "resignation",
  };
}

/**
 * The final chess state for entered results, as engine.ts would hold it after
 * the games: colours alternate (A has White in game 1), scores add 1 / ½ / 0.
 *
 * Group, Swiss and league: always over; `winner` is null for a draw (callers
 * finalising a drawn group game must not require a winner).
 * Knockout: over with a winner when one side has more points; when level the
 * state is NOT over and `needsArbiter` is set, exactly as engine.ts leaves a
 * drawn knockout for the organiser to decide.
 */
export function chessStateFromResults(
  games: ChessGameResult[],
  opts: { legs?: 1 | 2; competition: ChessCompetition },
): { ok: true; state: ChessState; outcome: ChessOutcome } | { ok: false; problems: ChessResultProblem[] } {
  const legs = opts.legs ?? 1;
  const problems = validateChessResults(games, legs);
  if (problems.length > 0) return { ok: false, problems };

  const outcome = chessOutcome(games, opts.competition);
  const played = games.map((r, i) => enteredGame(i % 2 === 0 ? "A" : "B", r));
  const knockout = opts.competition === "knockout";
  const level = outcome.winner === null;
  const state: ChessState = {
    legs,
    games: played,
    currentGameIndex: played.length - 1,
    scoreA: outcome.points.a,
    scoreB: outcome.points.b,
    needsArbiter: knockout && level,
    winner: outcome.winner,
    matchOver: !(knockout && level),
    servingTeam: null,
  };
  return { ok: true, state, outcome };
}

/** "1 - 0", "½ - ½", "1½ - ½": the pairing's score as chess writes it. */
export function chessScoreLine(points: { a: number; b: number }): string {
  const fmt = (n: number) => {
    const whole = Math.floor(n);
    if (n - whole === 0.5) return whole === 0 ? "½" : `${whole}½`;
    return String(n);
  };
  return `${fmt(points.a)} - ${fmt(points.b)}`;
}
