/**
 * Checks on a batch of score events before the sync route writes any of it.
 *
 * Pure: no database, no framework, so the web console, the native app and the
 * route all agree on what a valid batch is. The route still owns the sequence
 * check against the server's own numbering.
 */
import { awardPoint, type ScoreState, type TeamKey } from "./engine";
import type { ScoringConfig } from "../types";

/** Every event type a scoring client may send. Anything else is refused. */
export const SCORE_EVENT_TYPES = [
  "MATCH_STARTED",
  "POINT_AWARDED",
  "UNDO",
  "MATCH_PAUSED",
  "MATCH_RESUMED",
  "SERVER_CHANGED",
  "CODE_VIOLATION",
  "MANUAL_SET_END",
  "FORCE_END",
  "MATCH_ENDED",
  "WALKOVER",
  "DISQUALIFICATION",
  "RETIREMENT",
  // Chess
  "MOVE_MADE",
  "RESIGN",
  "DRAW_DECLARED",
] as const;

export type ScoreEventType = (typeof SCORE_EVENT_TYPES)[number];

/** Larger than any real offline backlog (a long set is ~60 points), small enough to bound one request. */
export const MAX_EVENTS_PER_BATCH = 200;

export interface BatchEvent {
  client_event_id: string;
  event_number: number;
  event_type: string;
  team_id: string | null;
  payload: Record<string, unknown> | null;
  new_state: unknown;
}

export interface BatchProblem {
  status: 400;
  error: string;
}

const UUIDISH = /^[0-9a-zA-Z-]{8,64}$/;

/**
 * Refuses a batch that no honest client can produce: unknown event types, a team
 * or winner that is not one of the match's two sides, missing ids or states.
 * Returns null when the batch is acceptable.
 */
export function batchProblem(
  events: BatchEvent[],
  match: { team_a_id: string | null; team_b_id: string | null },
): BatchProblem | null {
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return { status: 400, error: `At most ${MAX_EVENTS_PER_BATCH} events per sync` };
  }
  const sides = new Set([match.team_a_id, match.team_b_id].filter(Boolean) as string[]);
  const seen = new Set<string>();
  for (const e of events) {
    if (typeof e.client_event_id !== "string" || !UUIDISH.test(e.client_event_id)) {
      return { status: 400, error: "Every event needs a client_event_id" };
    }
    if (seen.has(e.client_event_id)) return { status: 400, error: "Duplicate client_event_id in one batch" };
    seen.add(e.client_event_id);
    if (!Number.isInteger(e.event_number) || e.event_number < 1) {
      return { status: 400, error: "event_number must be a positive whole number" };
    }
    if (!(SCORE_EVENT_TYPES as readonly string[]).includes(e.event_type)) {
      return { status: 400, error: `Unknown event type ${String(e.event_type).slice(0, 40)}` };
    }
    if (e.team_id != null && !sides.has(e.team_id)) {
      return { status: 400, error: "team_id is not one of this match's sides" };
    }
    const winner = e.payload?.winner_team_id;
    if (winner != null && (typeof winner !== "string" || !sides.has(winner))) {
      return { status: 400, error: "winner_team_id is not one of this match's sides" };
    }
    if (!e.new_state || typeof e.new_state !== "object") {
      return { status: 400, error: "Every event needs a new_state" };
    }
  }
  return null;
}

/** Order-insensitive structural equality, for comparing states that went through jsonb (which reorders keys). */
export function sameState(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    // jsonb stores whole-number floats as integers; treat 1 and 1.0 as equal.
    return typeof a === "number" && typeof b === "number" ? a === b : false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameState(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  // An absent key and an undefined value are the same thing after JSON.
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (ao[k] === undefined && bo[k] === undefined) continue;
    if (!sameState(ao[k], bo[k])) return false;
  }
  return true;
}

export interface ShadowMismatch {
  event_number: number;
  event_type: string;
  kind: "chain" | "point";
}

/**
 * Re-derives what the server can from the shared engine and reports where the
 * client's states disagree. Two checks:
 *  - chain: each event's previous_state is the state the previous event left
 *    (the first one against the server's own snapshot);
 *  - point: a POINT_AWARDED's new_state is what the engine gives for that point.
 * Reported, never enforced: this event runs it in shadow to prove the engine
 * and every client agree before anything is rejected on its say-so.
 */
export function shadowMismatches(
  events: { event_number: number; event_type: string; team_id: string | null; previous_state: unknown; new_state: unknown }[],
  opts: { snapshotState: unknown; teamA: string | null; config: ScoringConfig | null },
): ShadowMismatch[] {
  const out: ShadowMismatch[] = [];
  let expectedPrev = opts.snapshotState;
  for (const e of events) {
    if (expectedPrev != null && e.previous_state != null && !sameState(expectedPrev, e.previous_state)) {
      out.push({ event_number: e.event_number, event_type: e.event_type, kind: "chain" });
    }
    if (e.event_type === "POINT_AWARDED" && opts.config && e.previous_state && e.team_id) {
      const key: TeamKey = e.team_id === opts.teamA ? "A" : "B";
      try {
        const expected = awardPoint(e.previous_state as ScoreState, key, opts.config);
        if (!sameState(expected, e.new_state)) out.push({ event_number: e.event_number, event_type: e.event_type, kind: "point" });
      } catch {
        out.push({ event_number: e.event_number, event_type: e.event_type, kind: "point" });
      }
    }
    expectedPrev = e.new_state;
  }
  return out;
}
