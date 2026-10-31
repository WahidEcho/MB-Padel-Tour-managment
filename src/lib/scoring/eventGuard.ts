/**
 * Checks on a batch of score events before the sync route writes any of it.
 *
 * Pure: no database, no framework, so the web console, the native app and the
 * route all agree on what a valid batch is. The route still owns the sequence
 * check against the server's own numbering.
 */
import { awardPoint, opponent, type ScoreState, type TeamKey } from "./engine";
import { ace, applyLet, fault, serveNumber, setServeOrder, type ServeOrder } from "./serve";
import { isTimerKind, startClock, stopClock, TIME_DECISIONS, withoutClock, type TimerKind } from "./timing";
import { CARRY_GRACE_MINUTES } from "../orgs/courtScope";
import type { ScoringConfig } from "../types";
import type { ScoringFeatures } from "../matchday/rules";

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
  // A final result entered in one go (resultEntry.ts); the server rebuilds its state.
  "RESULT_ENTERED",
  // Scoring v2 (serve.ts, timing.ts). An ace and a double fault are POINT_AWARDED
  // events with payload { ace: true } / { double_fault: true }, so everything that
  // reads points (timelines, voice, screens, Move Score 1.0.1) keeps working.
  "FAULT",
  "LET",
  "SERVE_ORDER",
  "TIMER_STARTED",
  "TIMER_STOPPED",
  "TIME_DECISION",
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

/** Match statuses the server treats as a final result. */
export const FINISHED_MATCH_STATUSES = ["completed", "walkover", "disqualified", "retired"] as const;

/**
 * Events that end a match whatever the score says. RESULT_ENTERED is already the
 * confirmed result (the entry form has its own two-step confirmation), so result
 * confirmation never holds it — except a level chess knockout, which stays open
 * for the organiser to decide (its state is not over).
 */
const ENDING_EVENTS = new Set(["FORCE_END", "MATCH_ENDED", "WALKOVER", "DISQUALIFICATION", "RETIREMENT", "RESULT_ENTERED"]);

type OverLike = { matchOver?: unknown; winner?: unknown };
const overOf = (s: unknown): OverLike | null => (s && typeof s === "object" ? (s as OverLike) : null);

/**
 * An UNDO that takes a finished match back into play. Undoing past the winning
 * point always does. With result confirmation on, undoing the confirmation does
 * too: the score is still over, but the result is withdrawn until it is
 * confirmed again (the console shows the "Confirm result" card once more).
 */
export function reopensMatch(e: { event_type: string; new_state: unknown }, requiresConfirmation: boolean): boolean {
  return e.event_type === "UNDO" && (!overOf(e.new_state)?.matchOver || requiresConfirmation);
}

/** Whether the server finalises the match on this event (the events route's own rule). */
export function endsMatch(e: { event_type: string; new_state: unknown }, requiresConfirmation: boolean): boolean {
  if (e.event_type === "RESULT_ENTERED") return Boolean(overOf(e.new_state)?.matchOver);
  if (ENDING_EVENTS.has(e.event_type)) return true;
  const s = overOf(e.new_state);
  return Boolean(s?.matchOver && s.winner) && !requiresConfirmation;
}

export interface FinishedCut {
  /** Index in the batch of the first event refused; the events before it are fine. */
  index: number;
  error: string;
}

/**
 * Once a match is finished, the only events that may follow are an UNDO that
 * reopens it and a RESULT_ENTERED, which is an audited correction (the server
 * reopens the match, takes back what it awarded and finalises the new result).
 * A second MATCH_ENDED, or a WALKOVER after the match was won, would otherwise
 * rewrite a result that standings, brackets and screens already used.
 * Walks the batch in order (fresh events only, sorted), so a batch that finishes
 * the match, reopens it and plays on is still accepted.
 */
export function finishedMatchCut(
  status: string,
  events: { event_number: number; event_type: string; new_state: unknown }[],
  requiresConfirmation: boolean,
): FinishedCut | null {
  let finished = (FINISHED_MATCH_STATUSES as readonly string[]).includes(status);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (finished) {
      if (reopensMatch(e, requiresConfirmation)) {
        finished = false;
        continue;
      }
      if (e.event_type === "RESULT_ENTERED") {
        finished = endsMatch(e, requiresConfirmation);
        continue;
      }
      return {
        index: i,
        error: `This match is already finished, so event ${e.event_number} (${e.event_type}) was refused. Only Undo can reopen it; load the server's score to carry on.`,
      };
    }
    if (endsMatch(e, requiresConfirmation)) finished = true;
  }
  return null;
}

/** The roles that decide a result someone else recorded: the organiser's staff, never a referee. */
export const RESULT_DECIDERS: readonly string[] = ["admin", "manager"];

/** Event types that put no score on the match: a match with only these has nothing to correct yet. */
export const NON_SCORING_EVENTS: ReadonlySet<string> = new Set([
  "MATCH_STARTED",
  "MATCH_PAUSED",
  "MATCH_RESUMED",
  "SERVER_CHANGED",
  "FAULT",
  "LET",
  "SERVE_ORDER",
  "TIMER_STARTED",
  "TIMER_STOPPED",
  "TIME_DECISION",
]);

/**
 * Events only for the record: timers and the referee's ruling on an overrun. They
 * never go on the undo stack (Undo takes back the last scoring action, not a timer),
 * and timelines skip them.
 */
export const LOG_ONLY_EVENTS: ReadonlySet<string> = new Set(["TIMER_STARTED", "TIMER_STOPPED", "TIME_DECISION"]);

/** Whether an event pushes the state before it onto the undo stack (everything but UNDO and the log-only ones). */
export function pushesHistory(eventType: string): boolean {
  return eventType !== "UNDO" && !LOG_ONLY_EVENTS.has(eventType);
}

/**
 * A final result over a match that already has a score (a finished match, or
 * points, games or moves already recorded) replaces what someone recorded: an
 * audited correction, for the organiser's staff (admin, manager) only. A referee
 * still enters a match's first result, on a match with no score yet. `scoredBefore`:
 * the match is finished, or its log already holds a scoring event (any status).
 * The batch (fresh events, sorted) is walked in order. Returns the first refused
 * event, or null.
 */
export function correctionCut(
  role: string,
  scoredBefore: boolean,
  events: { event_number: number; event_type: string }[],
): FinishedCut | null {
  if (RESULT_DECIDERS.includes(role)) return null;
  let scored = scoredBefore;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.event_type === "RESULT_ENTERED" && scored) {
      return {
        index: i,
        error: `This match already has a score, so the result (event ${e.event_number}) is a correction: only the organiser (an admin or manager) can enter it.`,
      };
    }
    if (!NON_SCORING_EVENTS.has(e.event_type)) scored = true;
  }
  return null;
}

/**
 * Chess: a level pairing (every game played, equal match points) has a winner only by the organiser's
 * decision (decideWinner on the arbiter card, or the advance on an entered result,
 * which resultEntry already restricts). A scoring device's event that names a
 * winner on a level score, in its state or as payload.winner_team_id, is that
 * decision, and a referee may not make it. RESULT_ENTERED is left to the result
 * check (its state is rebuilt by the server). Returns the first refused event, or null.
 */
export function chessDecisionCut(
  role: string,
  events: { event_number: number; event_type: string; new_state: unknown; payload: Record<string, unknown> | null }[],
): FinishedCut | null {
  if (RESULT_DECIDERS.includes(role)) return null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.event_type === "RESULT_ENTERED") continue;
    const s = (e.new_state && typeof e.new_state === "object" ? e.new_state : {}) as {
      scoreA?: unknown;
      scoreB?: unknown;
      winner?: unknown;
      legs?: unknown;
      games?: { result?: unknown }[];
    };
    // Every game of the pairing played, and the match points equal: only a decision can end it.
    const games = Array.isArray(s.games) ? s.games : [];
    const allPlayed = games.length > 0 && games.length >= (typeof s.legs === "number" ? s.legs : 1) && games.every((g) => Boolean(g?.result));
    const level = allPlayed && typeof s.scoreA === "number" && typeof s.scoreB === "number" && s.scoreA === s.scoreB;
    const decides = Boolean(s.winner) || (e.payload?.winner_team_id != null && e.event_type !== "UNDO");
    if (level && decides) {
      return {
        index: i,
        error: `The pairing is level, so who advances is the organiser's decision (event ${e.event_number} was refused). Ask an admin or manager to decide it.`,
      };
    }
  }
  return null;
}

/**
 * An UNDO sent after a final result (RESULT_ENTERED) is refused: the result's
 * state was rebuilt by the server from the sets entered, not reached point by
 * point, so there is nothing to step back to. A result is changed only by a new
 * RESULT_ENTERED (an audited correction). `resultStored` is whether the match's
 * log already holds a result that is not superseded; the batch (fresh events,
 * sorted) is walked in order, so an UNDO before the result in the same batch is
 * still fine. Returns the first refused event, or null.
 */
export function undoAfterResultCut(
  resultStored: boolean,
  events: { event_number: number; event_type: string }[],
): FinishedCut | null {
  let result = resultStored;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.event_type === "RESULT_ENTERED") result = true;
    else if (e.event_type === "UNDO" && result) {
      return {
        index: i,
        error: `This match's result was entered in one go, so Undo (event ${e.event_number}) was refused. To change it, enter the corrected result.`,
      };
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

/**
 * A first-serve fault that no longer counts (the score moved on) is not part of the
 * score: Move Score 1.0.1's engine copies it along where today's drops it.
 */
function withoutStaleServe(s: ScoreState | null | undefined): unknown {
  if (!s || typeof s !== "object" || !("serve" in s) || !s.teamA) return s;
  if (serveNumber(s) === 2) return s;
  const copy = { ...s };
  delete copy.serve;
  return copy;
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
  events: { event_number: number; event_type: string; team_id: string | null; previous_state: unknown; new_state: unknown; payload?: Record<string, unknown> | null }[],
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
        const v2 = isV2Event(e) ? expectedV2State(e, { teamA: opts.teamA, config: opts.config }) : null;
        const expected = v2 && v2.ok ? v2.state : awardPoint(e.previous_state as ScoreState, key, opts.config);
        // A clock is not part of the score either: 1.0.1's engine copies a running one along.
        if (!sameState(withoutClock(withoutStaleServe(expected)), withoutClock(withoutStaleServe(e.new_state as ScoreState)))) {
          out.push({ event_number: e.event_number, event_type: e.event_type, kind: "point" });
        }
      } catch {
        out.push({ event_number: e.event_number, event_type: e.event_type, kind: "point" });
      }
    }
    expectedPrev = e.new_state;
  }
  return out;
}

/* ---------------- scoring v2: checked on the server, never just trusted ---------------- */

type V2Event = { event_type: string; team_id: string | null; previous_state: unknown; new_state?: unknown; payload?: Record<string, unknown> | null };

const V2_TYPES = new Set(["FAULT", "LET", "SERVE_ORDER", "TIMER_STARTED", "TIMER_STOPPED", "TIME_DECISION"]);

/** A v2 event: a new event type, or a point marked as an ace or a double fault. */
export function isV2Event(e: { event_type: string; payload?: Record<string, unknown> | null }): boolean {
  if (V2_TYPES.has(e.event_type)) return true;
  return e.event_type === "POINT_AWARDED" && (e.payload?.ace === true || e.payload?.double_fault === true);
}

const bit = (v: unknown): 0 | 1 | null => (v === 0 || v === 1 ? v : null);
const side = (v: unknown): TeamKey | null => (v === "A" || v === "B" ? v : null);

export function parseServeOrder(p: Record<string, unknown> | null | undefined): ServeOrder | null {
  if (!p) return null;
  const servingTeam = side(p.servingTeam);
  const server = bit(p.server);
  const receiver = bit(p.receiver);
  const otherServer = bit(p.otherServer);
  const otherReceiver = bit(p.otherReceiver);
  if (!servingTeam || server === null || receiver === null || otherServer === null || otherReceiver === null) return null;
  return { servingTeam, server, receiver, otherServer, otherReceiver };
}

export type V2Expected = { ok: true; state: ScoreState } | { ok: false; error: string };

/**
 * The state a v2 event must come to, re-derived from its previous state with the
 * shared engine (serve.ts, timing.ts), or why no honest console sends it. The
 * events route refuses a v2 event whose new_state differs.
 */
export function expectedV2State(e: V2Event, opts: { teamA: string | null; config: ScoringConfig; doubles?: boolean }): V2Expected {
  const prev = e.previous_state as ScoreState | null;
  if (!prev || typeof prev !== "object" || !prev.teamA || !prev.teamB) return { ok: false, error: `${e.event_type} needs the score before it` };
  const key: TeamKey | null = e.team_id == null ? null : e.team_id === opts.teamA ? "A" : "B";
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "FAULT": {
      const r = fault(prev, opts.config);
      if (!r || r.doubleFault) return { ok: false, error: "A second fault is a double fault: a point to the receiver" };
      if (key && key !== r.server) return { ok: false, error: "A fault belongs to the serving side" };
      return { ok: true, state: r.next };
    }
    case "POINT_AWARDED": {
      if (p.ace === true) {
        const r = ace(prev, opts.config);
        if (!r || key !== r.server) return { ok: false, error: "An ace is a point to the server" };
        return { ok: true, state: r.next };
      }
      const r = fault(prev, opts.config);
      if (!r || !r.doubleFault || key !== opponent(r.server)) return { ok: false, error: "A double fault comes after a fault: the point goes to the receiver" };
      return { ok: true, state: r.next };
    }
    case "LET": {
      if (p.kind !== "serve" && p.kind !== "point") return { ok: false, error: "A let is a serve let or a replayed point" };
      if (prev.matchOver) return { ok: false, error: "The match is over" };
      return { ok: true, state: applyLet(prev, p.kind) };
    }
    case "SERVE_ORDER": {
      // Doubles only, at the start of a set (setServeOrder).
      if (opts.doubles === false) return { ok: false, error: "A singles match has no serve and receive order" };
      const order = parseServeOrder(p);
      const next = order ? setServeOrder(prev, order) : null;
      if (!next) {
        return { ok: false, error: "The serve and receive order is set at the start of a set" };
      }
      return { ok: true, state: next };
    }
    case "TIMER_STARTED": {
      const started = typeof p.started_at === "string" && Number.isFinite(Date.parse(p.started_at)) ? p.started_at : null;
      if (!isTimerKind(p.timer) || !started) return { ok: false, error: "Unknown timer" };
      return { ok: true, state: startClock(prev, p.timer as TimerKind, started, side(p.team)) };
    }
    case "TIMER_STOPPED":
      return { ok: true, state: stopClock(prev) };
    case "TIME_DECISION": {
      if (!isTimerKind(p.timer) || !(TIME_DECISIONS as readonly string[]).includes(String(p.decision))) {
        return { ok: false, error: "A time ruling names its timer and the decision" };
      }
      return { ok: true, state: prev };
    }
  }
  return { ok: false, error: `Not a v2 event: ${e.event_type}` };
}

/** The admin setting a v2 event depends on, or null when it always may be sent (stopping a timer). */
export function featureFor(e: { event_type: string; payload?: Record<string, unknown> | null }): keyof ScoringFeatures | null {
  const p = e.payload ?? {};
  const timerFeature = (t: unknown): keyof ScoringFeatures | null =>
    t === "between_points"
      ? "timerBetweenPoints"
      : t === "changeover"
        ? "timerChangeover"
        : t === "set_break"
          ? "timerSetBreak"
          : t === "break"
            ? "breakStopwatch"
            : t === "bathroom"
              ? "bathroom"
              : t === "hydration"
                ? "hydration"
                : null;
  switch (e.event_type) {
    case "FAULT":
      return "fault";
    case "POINT_AWARDED":
      return p.ace === true ? "ace" : p.double_fault === true ? "fault" : null;
    case "LET":
      return "let";
    case "SERVE_ORDER":
      return "doublesOrder";
    case "TIMER_STARTED":
    case "TIME_DECISION":
      return timerFeature(p.timer);
    default:
      return null;
  }
}

/**
 * The first v2 event of a batch the tournament switched off, or whose state is not
 * what the engine gives. Walked in order; returns the index and why, or null.
 * Aces and double faults are compared without `clock`: a point closes a running
 * timer (engine.ts), and a console built before that may still carry it along.
 * That the event starts from the server's own score is v2ChainCut's check.
 */
export function v2Cut(
  events: V2Event[],
  opts: { teamA: string | null; config: ScoringConfig | null; features: ScoringFeatures; doubles?: boolean },
): (FinishedCut & { code: "feature_off" | "state_mismatch" }) | null {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!isV2Event(e)) continue;
    const feature = featureFor(e);
    if (feature && !opts.features[feature]) {
      return { index: i, code: "feature_off", error: `The organiser switched this off for the tournament (${feature}), so event ${e.event_type} was refused.` };
    }
    if (!opts.config) return { index: i, code: "state_mismatch", error: `${e.event_type} is for games scoring only` };
    const want = expectedV2State(e, { teamA: opts.teamA, config: opts.config, doubles: opts.doubles });
    if (!want.ok) return { index: i, code: "state_mismatch", error: want.error };
    const same = e.event_type === "POINT_AWARDED" ? sameState(withoutClock(want.state), withoutClock(e.new_state)) : sameState(want.state, e.new_state);
    if (!same) {
      return { index: i, code: "state_mismatch", error: `The score sent with ${e.event_type} is not what the rules give. Load the server's score and carry on.` };
    }
  }
  return null;
}

/**
 * The server re-derives a v2 event's new_state from its previous_state (v2Cut), so
 * that previous_state must be the server's own score, never just the device's word:
 * a v2 event that is the batch's first fresh event must carry the stored score
 * (`storedState`: the snapshot, brought level with the event log), and a later one
 * the new_state of the event just before it in the batch. Otherwise `stale_state`.
 *
 * Only v2 events are held to it. Every other event's new_state is the device's own
 * (Move Score 1.0.1 included) and nothing is re-derived from its previous_state, so
 * checking it would refuse no forgery and risk refusing an old phone; the sequence
 * check and the device lease keep those in order. Fresh events only, sorted.
 */
export function v2ChainCut(
  events: { event_number: number; event_type: string; previous_state: unknown; new_state: unknown; payload?: Record<string, unknown> | null }[],
  storedState: unknown,
): (FinishedCut & { code: "stale_state" }) | null {
  let expected: unknown = storedState ?? null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (isV2Event(e) && !sameState(expected, e.previous_state ?? null)) {
      return {
        index: i,
        code: "stale_state",
        error: `${e.event_type} (event ${e.event_number}) does not start from the server's score, so it was refused. Load the server's score and carry on.`,
      };
    }
    expected = e.new_state ?? null;
  }
  return null;
}

/* ---------------- chair umpire codes and finished matches ---------------- */

/** The parts of a staff principal (src/lib/auth/staff.ts StaffPrincipal) that say whether it is a court code. */
export interface WriterScope {
  scopeCourt?: unknown;
  scopeMatchIds?: string[] | null;
  scopeTournamentIds?: string[] | null;
  referee?: { role?: string } | null;
}

/**
 * A chair umpire code (one physical court, migration 0034) or its carry-over token
 * after a court switch: not a master referee, a whole-event code or a member.
 */
export function isCourtCode(staff: WriterScope | null | undefined): boolean {
  if (!staff) return false;
  if (staff.scopeTournamentIds || staff.referee?.role === "master_referee") return false;
  return Boolean(staff.scopeCourt) || Boolean(staff.scopeMatchIds?.length);
}

/**
 * A court code may still write to a match the server has finished (an Undo that
 * reopens it, the unsent last points) for CARRY_GRACE_MINUTES after it ended
 * (`matches.ended_at`); after that the result is the organiser's and the master
 * referee's to change, never the court phone's. The whole batch is refused
 * (index 0): it starts on the finished match. A match finished with no end time
 * counts as ended long ago. Null when the writer is not a court code, the match is
 * not finished, or the grace still runs.
 */
export function finishedLockCut(
  courtCode: boolean,
  match: { status: string; ended_at?: string | null },
  events: { event_number: number; event_type: string }[],
  nowMs = Date.now(),
): (FinishedCut & { code: "finished_locked" }) | null {
  if (!courtCode || events.length === 0) return null;
  if (!(FINISHED_MATCH_STATUSES as readonly string[]).includes(match.status)) return null;
  const ended = match.ended_at ? Date.parse(match.ended_at) : NaN;
  if (Number.isFinite(ended) && nowMs - ended <= CARRY_GRACE_MINUTES * 60_000) return null;
  return {
    index: 0,
    code: "finished_locked",
    error: `This match finished more than ${CARRY_GRACE_MINUTES} minutes ago, so a chair umpire code can no longer change it (event ${events[0].event_number}, ${events[0].event_type}). Ask the master referee or the organiser.`,
  };
}
