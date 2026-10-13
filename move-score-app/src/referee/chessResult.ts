/**
 * A chess result entered on the referee's phone, built the way the server builds
 * it (src/lib/scoring/append.ts checkResult), so the state it sends is the state
 * the server arrives at. A referee's result goes through `queueableResult` (no
 * "who advances"); the organiser (admin or manager) may pick who advances from a
 * level knockout pairing, applied as the chess engine's decideWinner() does.
 */
import { DEFAULT_SCORING_CONFIG, buildResultState, parseResultPayload, queueableResult, type ChessCompetition, type ResultPayload, type ResultProblem, type TeamKey } from "@core";

export type ChessEntry = { ok: true; payload: ResultPayload; state: unknown; winner: TeamKey | null } | { ok: false; problems: ResultProblem[] };

export function chessEntry(raw: ResultPayload, opts: { mode: string; competition: ChessCompetition; legs: 1 | 2; organiser: boolean }): ChessEntry {
  const advance = "chess" in raw ? (raw.advance ?? null) : null;
  if (!advance || !opts.organiser) {
    const q = queueableResult({ mode: opts.mode, engine: "chess", rules: DEFAULT_SCORING_CONFIG, payload: raw, competition: opts.competition, legs: opts.legs });
    return q.ok ? { ok: true, payload: q.payload, state: q.state, winner: q.winner } : q;
  }
  // The organiser's decision on a level knockout pairing.
  const okMode = opts.mode === "final_score" || opts.mode === "either";
  if (!okMode) return { ok: false, problems: [{ code: "mode", set: null, message: "This match is scored point by point." }] };
  const parsed = parseResultPayload(raw, "chess");
  if (!parsed.ok) return parsed;
  const built = buildResultState({ engine: "chess", rules: DEFAULT_SCORING_CONFIG, payload: parsed.payload, competition: opts.competition, legs: opts.legs });
  if (!built.ok) return built;
  if (built.engine !== "chess" || !built.level || !built.advance) {
    return { ok: false, problems: [{ code: "advance_not_needed", set: null, message: "One side won the pairing, so nobody needs to be picked to advance." }] };
  }
  const state = { ...built.state, winner: built.advance, matchOver: true, needsArbiter: false };
  return { ok: true, payload: parsed.payload, state, winner: built.advance };
}
