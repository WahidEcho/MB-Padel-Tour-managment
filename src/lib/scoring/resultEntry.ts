/**
 * A final result as one score event (Phase 2): `RESULT_ENTERED`.
 *
 * The event carries what was typed, never a trusted state:
 *   games sports   payload { sets: EnteredSet[] }             (see finalScore.ts)
 *   chess          payload { chess: ChessGameResult[], advance? }
 *
 * The server rebuilds the state from the payload with the match's own rules and
 * refuses a client `new_state` that differs, so a result entered by a referee
 * phone, the web console or the admin page always reads, to standings, brackets,
 * points and screens, exactly like a match scored point by point.
 *
 * Chess: a draw is only a finished result where a draw scores (groups, Swiss,
 * leagues). Every chess competition today is a knockout, so a level knockout
 * pairing is recorded as level and NOT over: the organiser decides who advances
 * (`advance`, applied with engine.ts's existing `decideWinner()` by the server).
 * Draws outside a knockout are refused with `draw_unsupported` until a chess
 * format with a group or league table exists (standings have no draws yet).
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import type { MatchRules } from "../types";
import type { ScoreState, TeamKey } from "./engine";
import { stateFromFinalScore, type EnteredSet, type FinalScoreProblemCode } from "./finalScore";
import {
  chessStateFromResults,
  type ChessCompetition,
  type ChessGameResult,
  type ChessResultProblemCode,
  type ChessState,
  type Side,
} from "../chess/result";

export const RESULT_ENTERED = "RESULT_ENTERED";

/** How a match is recorded (matchday/rules.ts ScoringModeChoice, restated to keep this file small). */
type ScoringModeChoice = "point_by_point" | "final_score" | "either";

export type GamesResultPayload = { sets: EnteredSet[] };
export type ChessResultPayload = { chess: ChessGameResult[]; advance?: Side | null };
export type ResultPayload = GamesResultPayload | ChessResultPayload;

export type ResultProblemCode =
  | FinalScoreProblemCode
  | ChessResultProblemCode
  /** The match is recorded point by point (match override → session → match-day rules). */
  | "mode"
  /** The payload is not the shape this sport's result takes. */
  | "payload"
  /** A chess draw where draws do not score yet (see the header). */
  | "draw_unsupported"
  /** Only the organiser (admin or manager) picks who advances from a level knockout pairing. */
  | "advance_not_allowed"
  /** `advance` sent for a pairing that one side won outright. */
  | "advance_not_needed"
  /** The client's new_state is not the state the server built from the payload. */
  | "state_mismatch"
  /** team_id or winner_team_id names the side that did not win the entered result. */
  | "winner_mismatch"
  /** The match cannot take a result (a side is not known yet, or it was cancelled). */
  | "not_playable";

export interface ResultProblem {
  code: ResultProblemCode;
  /** 0-based set (or game) index, when the problem is about one. */
  set: number | null;
  message: string;
}

export function finalResultAllowed(mode: ScoringModeChoice | string | null | undefined): boolean {
  return mode === "final_score" || mode === "either";
}

/** Where a chess game is played, from the match's stage. */
export function chessCompetitionFor(stage: string | null | undefined): ChessCompetition {
  if (stage === "group") return "group";
  if (stage === "friendly") return "league";
  return "knockout";
}

const MAX_SETS = 9;
const MAX_SCORE = 99;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const small = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_SCORE;
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const bad = (message: string, set: number | null = null): { ok: false; problems: ResultProblem[] } => ({
  ok: false,
  problems: [{ code: "payload", set, message }],
});

/** The payload in its exact shape (unknown fields refused, sizes bounded), or why not. */
export function parseResultPayload(
  raw: unknown,
  engine: "games" | "chess",
): { ok: true; payload: ResultPayload } | { ok: false; problems: ResultProblem[] } {
  if (!isRecord(raw)) return bad("A result needs its score.");
  if (engine === "chess") {
    if (!onlyKeys(raw, ["chess", "advance"])) return bad("A chess result has only the game results and who advances.");
    const games = raw.chess;
    if (!Array.isArray(games) || games.length === 0 || games.length > 2) return bad("Enter the result of each game.");
    if (games.some((g) => g !== "A" && g !== "B" && g !== "draw")) return bad("Each game is a win for one side or a draw.");
    const advance = raw.advance ?? null;
    if (advance !== null && advance !== "A" && advance !== "B") return bad("Who advances must be one of the two sides.");
    return { ok: true, payload: { chess: games as ChessGameResult[], ...(advance ? { advance } : {}) } };
  }
  if (!onlyKeys(raw, ["sets"])) return bad("A result has only its sets.");
  const sets = raw.sets;
  if (!Array.isArray(sets) || sets.length === 0) return bad("Enter the score of at least one set.");
  if (sets.length > MAX_SETS) return bad(`At most ${MAX_SETS} sets.`);
  const out: EnteredSet[] = [];
  for (let i = 0; i < sets.length; i++) {
    const s = sets[i];
    if (!isRecord(s) || !onlyKeys(s, ["a", "b", "tb"])) return bad(`Set ${i + 1}: a set has two scores and its tie-break.`, i);
    if (!small(s.a) || !small(s.b)) return bad(`Set ${i + 1}: games must be whole numbers from 0 to ${MAX_SCORE}.`, i);
    const tb = s.tb ?? null;
    if (tb !== null) {
      if (!isRecord(tb) || !onlyKeys(tb, ["a", "b"]) || !small(tb.a) || !small(tb.b)) {
        return bad(`Set ${i + 1}: tie-break points must be whole numbers from 0 to ${MAX_SCORE}.`, i);
      }
      out.push({ a: s.a as number, b: s.b as number, tb: { a: tb.a as number, b: tb.b as number } });
    } else {
      out.push({ a: s.a as number, b: s.b as number });
    }
  }
  return { ok: true, payload: { sets: out } };
}

export type ResultBuild =
  | {
      ok: true;
      engine: "games";
      state: ScoreState;
      winner: TeamKey;
    }
  | {
      ok: true;
      engine: "chess";
      /** As entered; a level knockout pairing is not over (needsArbiter) until `advance` is applied. */
      state: ChessState;
      winner: Side | null;
      /** A level knockout pairing: the organiser decides who advances. */
      level: boolean;
      advance: Side | null;
    }
  | { ok: false; problems: ResultProblem[] };

/**
 * The state a result comes to under the match's rules. Games: the finished
 * engine state (stateFromFinalScore). Chess: the entered games; for a level
 * knockout the caller applies `advance` with engine.ts's decideWinner().
 */
export function buildResultState(input: {
  engine: "games" | "chess";
  rules: MatchRules;
  payload: ResultPayload;
  competition?: ChessCompetition;
  legs?: 1 | 2;
  firstServer?: TeamKey;
}): ResultBuild {
  if (input.engine === "chess") {
    if (!("chess" in input.payload)) return bad("A chess result has game results, not sets.");
    const competition = input.competition ?? "knockout";
    const built = chessStateFromResults(input.payload.chess, { legs: input.legs ?? 1, competition });
    if (!built.ok) return { ok: false, problems: built.problems.map((p) => ({ code: p.code, set: null, message: p.message })) };
    const knockout = competition === "knockout";
    const level = built.outcome.winner === null;
    if (level && !knockout) {
      return {
        ok: false,
        problems: [{ code: "draw_unsupported", set: null, message: "A drawn result does not count in this competition yet: enter who won." }],
      };
    }
    const advance = input.payload.advance ?? null;
    if (advance && !level) {
      return { ok: false, problems: [{ code: "advance_not_needed", set: null, message: "One side won the pairing, so nobody needs to be picked to advance." }] };
    }
    return { ok: true, engine: "chess", state: built.state, winner: built.outcome.winner, level: knockout && level, advance };
  }
  if (!("sets" in input.payload)) return bad("A result has sets, not chess games.");
  const built = stateFromFinalScore(input.rules, input.payload.sets, { firstServer: input.firstServer });
  if (!built.ok) return { ok: false, problems: built.problems };
  return { ok: true, engine: "games", state: built.state, winner: built.state.winner as TeamKey };
}

/** The first problem as one sentence, for an error banner. */
export function resultProblemMessage(problems: ResultProblem[]): string {
  return problems[0]?.message ?? "This result cannot be recorded.";
}
