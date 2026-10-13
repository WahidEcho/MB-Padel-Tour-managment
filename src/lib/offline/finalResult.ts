/**
 * Final results in the referee's offline queue (Phase 2). Pure: no Dexie, no
 * browser, so the web console and the Move Score app queue a result the same way.
 *
 * 1. Validate before queueing (`queueableResult`): a result the rules cannot
 *    produce never enters the queue, so it can never block the points behind it.
 * 2. A result the server still refuses (`resultRejection`) — a bad score it
 *    caught, a client state that differs, the match moved on while this device
 *    was offline — is taken out of the queue together with anything queued after
 *    it (those were built on the refused state), the device goes back to the
 *    score before it, and the referee is asked to enter the result again. The
 *    match is never left stuck behind a result the server will not take.
 */
import type { MatchRules } from "../types";
import type { TeamKey } from "../scoring/engine";
import type { ChessCompetition } from "../chess/result";
import {
  RESULT_ENTERED,
  buildResultState,
  finalResultAllowed,
  parseResultPayload,
  type ResultPayload,
  type ResultProblem,
} from "../scoring/resultEntry";

export type QueueableResult =
  | { ok: true; payload: ResultPayload; state: unknown; winner: TeamKey | null; over: boolean }
  | { ok: false; problems: ResultProblem[] };

/** The event a referee may queue for this result, or the problems to show instead. */
export function queueableResult(input: {
  mode: string;
  engine: "games" | "chess";
  rules: MatchRules;
  payload: unknown;
  competition?: ChessCompetition;
  legs?: 1 | 2;
}): QueueableResult {
  if (!finalResultAllowed(input.mode)) {
    return { ok: false, problems: [{ code: "mode", set: null, message: "This match is scored point by point." }] };
  }
  const parsed = parseResultPayload(input.payload, input.engine);
  if (!parsed.ok) return parsed;
  // A referee never picks who advances from a level knockout: the organiser does.
  if ("chess" in parsed.payload && parsed.payload.advance) {
    return { ok: false, problems: [{ code: "advance_not_allowed", set: null, message: "The organiser decides who advances." }] };
  }
  const built = buildResultState({
    engine: input.engine,
    rules: input.rules,
    payload: parsed.payload,
    competition: input.competition,
    legs: input.legs,
  });
  if (!built.ok) return built;
  return { ok: true, payload: parsed.payload, state: built.state, winner: built.winner, over: built.state.matchOver };
}

export interface QueuedEventLike {
  client_event_id: string;
  event_number: number;
  event_type: string;
  previous_state: unknown;
  payload?: Record<string, unknown> | null;
}

export interface ResultRejection<E extends QueuedEventLike = QueuedEventLike> {
  /** The refused result. */
  result: E;
  /** Every queued event to remove: the result and anything after it. */
  drop: E[];
  /** The state the device goes back to (the score before the result). */
  restore: unknown;
  /** The event number the device carries on from. */
  lastEventNumber: number;
  message: string;
  problems: ResultProblem[];
}

/**
 * Whether a refused sync was about a queued final result, and what to take out
 * of the queue. A 400 names the refused result (`event`); a 409 (another device,
 * a score that moved on) refuses a queued result whatever it was.
 */
export function resultRejection<E extends QueuedEventLike>(
  pending: E[],
  status: number,
  body: unknown,
): ResultRejection<E> | null {
  if (status !== 400 && status !== 409) return null;
  const b = (body && typeof body === "object" ? body : {}) as { event?: unknown; error?: unknown; problems?: unknown; code?: unknown };
  const sorted = [...pending].sort((x, y) => x.event_number - y.event_number);
  const named = typeof b.event === "string" ? sorted.find((e) => e.client_event_id === b.event && e.event_type === RESULT_ENTERED) : undefined;
  if (status === 400 && !named) return null;
  const result = named ?? sorted.find((e) => e.event_type === RESULT_ENTERED);
  if (!result) return null;
  const drop = sorted.filter((e) => e.event_number >= result.event_number);
  const problems = Array.isArray(b.problems) ? (b.problems as ResultProblem[]) : [];
  const message = typeof b.error === "string" && b.error ? b.error : "The result was not accepted.";
  return {
    result,
    drop,
    restore: result.previous_state,
    lastEventNumber: result.event_number - 1,
    message,
    problems,
  };
}

/** The entered sets (or chess games) of a queued result, to fill the form again. */
export function resultPayloadOf(e: Pick<QueuedEventLike, "payload">): ResultPayload | null {
  const p = e.payload;
  if (!p || typeof p !== "object") return null;
  if (Array.isArray((p as { sets?: unknown }).sets)) return { sets: (p as { sets: never }).sets };
  if (Array.isArray((p as { chess?: unknown }).chess)) return { chess: (p as { chess: never }).chess };
  return null;
}
