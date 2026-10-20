/**
 * What each button on a scoring console records: the event type, the new state,
 * the team and payload, and the status the console should show. Pure.
 *
 * Written to match the web console (src/app/referee/matches/[matchId]/score/
 * ScoreClient.tsx) action for action, so the native console sends identical
 * events; console.test.ts pins the two together. The web console still has its
 * own copy for now; moving it onto this module is planned after the event.
 */
import {
  awardPoint,
  changeServer,
  currentServer,
  endsChange,
  initialScoreState,
  manualEndSet,
  pointOutcome,
  servingPlayer,
  swapDoublesServer,
  type EndsChange,
  type ScoreState,
  type TeamKey,
} from "./engine";
import { applyViolation, nextPenalty, type Offence, type Penalty } from "./conduct";
import { pushesHistory, sameState } from "./eventGuard";
import { ace as aceState, applyLet, fault as faultState, serveNumber, setServeOrder, type LetKind, type ServeOrder } from "./serve";
import { afterScoreChange, startClock, stopClock, withoutClock, type AfterPoint, type TimeDecision, type TimerKind } from "./timing";
import type { ScoringConfig } from "../types";

export interface ConsoleEvent {
  eventType: string;
  next: ScoreState;
  /** The side the event belongs to; the caller maps it to that side's team id. */
  team: TeamKey | null;
  /** `winner` is replaced by the caller with `winner_team_id` for that side. */
  payload: Record<string, unknown> | null;
  winner?: TeamKey;
  /** The status the console shows once recorded. "finished" means completed / walkover / … by the event. */
  newStatus?: string;
  /** Tennis: a changeover or set break to time after this event. */
  ends?: EndsChange;
  /** Scoring v2: the change of ends and the timer that follows a step that moved the score. */
  after?: AfterPoint;
}

export interface ConsoleOptions {
  config: ScoringConfig;
  /** The tournament asks the referee to confirm a result before it counts. */
  confirmFirst: boolean;
  online: boolean;
  tennis: boolean;
  doubles: boolean;
}

const done = (online: boolean, status: string) => (online ? status : "pending_sync");

export function startMatch(firstServer: TeamKey): ConsoleEvent {
  return { eventType: "MATCH_STARTED", next: initialScoreState(firstServer), team: null, payload: { first_server: firstServer }, newStatus: "live" };
}

/** Whether a tap needs the "about to win the game / set / match" check first. */
export function pointNeedsConfirm(cur: ScoreState, team: TeamKey, o: ConsoleOptions): string | null {
  const out = pointOutcome(cur, team, o.config);
  if (out.winsMatch && o.confirmFirst) return null;
  if (out.winsMatch) return "the MATCH";
  if (out.winsSet) return "the set";
  if (out.winsGame) return "this game";
  return null;
}

export function point(cur: ScoreState, team: TeamKey, o: ConsoleOptions): ConsoleEvent {
  const next = awardPoint(cur, team, o.config);
  return pointLike(cur, next, team, null, o);
}

function pointLike(cur: ScoreState, next: ScoreState, team: TeamKey, payload: Record<string, unknown> | null, o: ConsoleOptions): ConsoleEvent {
  const ended = next.matchOver && !o.confirmFirst;
  return {
    eventType: "POINT_AWARDED",
    next,
    team,
    payload,
    newStatus: ended ? done(o.online, "completed") : undefined,
    ends: o.tennis ? endsChange(cur, next) : undefined,
    after: afterScoreChange(cur, next),
  };
}

/* ---------------- scoring v2 (serve.ts, timing.ts) ---------------- */

/** Fault: a first fault goes to the second serve (FAULT); a second is a double fault, a point to the receiver. */
export function faultEvent(cur: ScoreState, o: ConsoleOptions): ConsoleEvent | null {
  const r = faultState(cur, o.config);
  if (!r) return null;
  if (!r.doubleFault) return { eventType: "FAULT", next: r.next, team: r.server, payload: { serve: 1 } };
  return pointLike(cur, r.next, r.server === "A" ? "B" : "A", { double_fault: true }, o);
}

/** Ace: a point to the server, counted as an ace. */
export function aceEvent(cur: ScoreState, o: ConsoleOptions): ConsoleEvent | null {
  const r = aceState(cur, o.config);
  if (!r) return null;
  return pointLike(cur, r.next, r.server, { ace: true }, o);
}

/** Let: "serve" replays the serve (a second serve stays second), "point" replays the point from a first serve. */
export function letEvent(cur: ScoreState, kind: LetKind): ConsoleEvent | null {
  if (cur.matchOver) return null;
  return { eventType: "LET", next: applyLet(cur, kind), team: null, payload: { kind, serve: serveNumber(cur) } };
}

/**
 * Doubles: the serve and receive order for this set (the set-start question). Null in
 * singles (`doubles` false), away from a set's start, and for a serving team the
 * rotation does not give after the first set (setServeOrder).
 */
export function serveOrderEvent(cur: ScoreState, order: ServeOrder, doubles?: boolean): ConsoleEvent | null {
  if (doubles === false) return null;
  const next = setServeOrder(cur, order);
  if (!next) return null;
  return { eventType: "SERVE_ORDER", next, team: null, payload: { ...order, set: cur.currentSet } };
}

/** A timer starts (changeover, set break, a break from More). `team`: whose break, when it is one side's. */
export function timerStart(cur: ScoreState, kind: TimerKind, startedAt: string, team: TeamKey | null = null): ConsoleEvent {
  return { eventType: "TIMER_STARTED", next: startClock(cur, kind, startedAt, team), team, payload: { timer: kind, started_at: startedAt, ...(team ? { team } : {}) } };
}

/** The running timer stops; `seconds` is how long it ran. */
export function timerStop(cur: ScoreState, kind: string, seconds: number, team: TeamKey | null = null): ConsoleEvent {
  return { eventType: "TIMER_STOPPED", next: stopClock(cur), team, payload: { timer: kind, seconds: Math.max(0, Math.round(seconds)), ...(team ? { team } : {}) } };
}

/** The referee's ruling on an overrun (a code violation is recorded as its own CODE_VIOLATION too). */
export function timeDecision(cur: ScoreState, kind: TimerKind, decision: TimeDecision, seconds: number, team: TeamKey | null): ConsoleEvent {
  return {
    eventType: "TIME_DECISION",
    next: cur,
    team,
    payload: { timer: kind, decision, seconds: Math.max(0, Math.round(seconds)), ...(team ? { team } : {}) },
  };
}

export function confirmResult(cur: ScoreState, o: ConsoleOptions): ConsoleEvent | null {
  if (!cur.matchOver || !cur.winner) return null;
  return { eventType: "MATCH_ENDED", next: cur, team: cur.winner, payload: {}, winner: cur.winner, newStatus: done(o.online, "completed") };
}

/** Undo: back to the state before the last scoring step. A timer that ran there stays over (no `clock`). */
export function undo(history: ScoreState[], finished: boolean): ConsoleEvent | null {
  const prev = history[history.length - 1];
  if (!prev) return null;
  return { eventType: "UNDO", next: withoutClock(prev), team: null, payload: null, newStatus: finished ? "live" : undefined };
}

export function togglePause(cur: ScoreState, paused: boolean): ConsoleEvent {
  return paused
    ? { eventType: "MATCH_RESUMED", next: cur, team: null, payload: null, newStatus: "live" }
    : { eventType: "MATCH_PAUSED", next: cur, team: null, payload: null, newStatus: "paused" };
}

export function switchServer(cur: ScoreState): ConsoleEvent | null {
  if (cur.matchOver) return null;
  return { eventType: "SERVER_CHANGED", next: changeServer(cur, currentServer(cur) === "A" ? "B" : "A"), team: null, payload: null };
}

export function swapServerInTeam(cur: ScoreState, team: TeamKey): ConsoleEvent | null {
  if (cur.matchOver) return null;
  return { eventType: "SERVER_CHANGED", next: swapDoublesServer(cur, team), team: null, payload: null };
}

export function violationPenalty(cur: ScoreState, offender: TeamKey, offence: Offence): Penalty {
  return nextPenalty(cur, offender, offence, currentServer(cur) === offender);
}

export function violation(cur: ScoreState, offender: TeamKey, offence: Offence, o: ConsoleOptions): ConsoleEvent | null {
  if (cur.matchOver) return null;
  const penalty = violationPenalty(cur, offender, offence);
  const serving = servingPlayer(cur);
  const next = applyViolation(cur, { team: offender, offence, penalty, player: o.doubles && serving?.team === offender ? serving.index : null }, o.config);
  return {
    eventType: "CODE_VIOLATION",
    next,
    team: offender,
    payload: { offence, penalty },
    newStatus: next.matchOver && !o.confirmFirst ? done(o.online, "completed") : undefined,
    ends: o.tennis ? endsChange(cur, next) : undefined,
    after: afterScoreChange(cur, next),
  };
}

export function endSet(cur: ScoreState, winner: TeamKey, o: ConsoleOptions): ConsoleEvent {
  const next = manualEndSet(cur, winner, o.config);
  return { eventType: "MANUAL_SET_END", next, team: winner, payload: null, newStatus: next.matchOver && !o.confirmFirst ? done(o.online, "completed") : undefined };
}

export type EndKind = "FORCE_END" | "WALKOVER" | "RETIREMENT" | "DISQUALIFICATION";
const END_STATUS: Record<EndKind, string> = { FORCE_END: "completed", WALKOVER: "walkover", RETIREMENT: "retired", DISQUALIFICATION: "disqualified" };

/** Ends the match early for one side. A set in progress is kept, so the summary shows real games. */
export function endWith(cur: ScoreState, kind: EndKind, winner: TeamKey, online: boolean): ConsoleEvent {
  const extraSet =
    (cur.teamA.games > 0 || cur.teamB.games > 0) && !cur.completedSets.some((s) => s.teamAGames === cur.teamA.games && s.teamBGames === cur.teamB.games)
      ? [{ teamAGames: cur.teamA.games, teamBGames: cur.teamB.games }]
      : [];
  const next: ScoreState = withoutClock({ ...cur, completedSets: [...cur.completedSets, ...extraSet], matchOver: true, winner });
  return { eventType: kind, next, team: winner, payload: {}, winner, newStatus: done(online, END_STATUS[kind]) };
}

/** The undo stack after an event, kept the way the web console keeps it (200 deep). Entries carry no running timer. */
export function nextHistory(history: ScoreState[], prev: ScoreState | null, eventType: string): ScoreState[] {
  if (eventType !== "UNDO" && !pushesHistory(eventType)) return history;
  return (eventType === "UNDO" ? history.slice(0, -1) : prev ? [...history, withoutClock(prev)] : history).slice(-200);
}

/** Statuses a console treats as over. `pending_sync` is a result recorded offline and not yet sent. */
export const FINISHED_STATUSES = ["completed", "walkover", "disqualified", "retired", "cancelled", "pending_sync"];

/** Over on the console: a final status, or a final score that needs no confirmation. */
export function isFinished(status: string, state: ScoreState | null, confirmFirst: boolean): boolean {
  return FINISHED_STATUSES.includes(status) || (Boolean(state?.matchOver) && !confirmFirst);
}

export interface RestoreInput {
  /** The server's last event number and score. */
  serverNo: number;
  serverState: unknown;
  /** The phone's own copy of the match, or null when this phone never scored it. */
  localNo: number | null;
  /** The phone's queued events for the match that were not given up (sent or still waiting). */
  rows: { n: number; pending: boolean; state: unknown }[];
}

/**
 * Which score a console opens on: its own ("local"), the server's ("server"),
 * or neither without asking the referee ("ask") — when this phone holds unsent
 * points that do not follow on from the server's score, so sending them would
 * be refused (another device scored meanwhile, or a write was lost).
 *
 * The phone's copy is used only when its unsent points carry straight on from
 * the server's last event: they start at the next number, or the gap between is
 * points this phone already sent (the server copy at hand is older than them),
 * or the server already holds this phone's points (a lost reply).
 */
export function restoreChoice(i: RestoreInput): "local" | "server" | "ask" {
  const have = new Map(i.rows.map((r) => [r.n, r]));
  const covers = (from: number, to: number) => {
    for (let n = from; n <= to; n++) if (!have.has(n)) return false;
    return true;
  };
  const pending = i.rows.filter((r) => r.pending).map((r) => r.n).sort((a, b) => a - b);
  if (i.localNo === null) return pending.length ? "ask" : "server";
  if (!pending.length) {
    // Nothing waiting. Ahead of this server copy only if the phone sent the rest itself.
    return i.localNo > i.serverNo && covers(i.serverNo + 1, i.localNo) ? "local" : "server";
  }
  const first = pending[0];
  const last = pending[pending.length - 1];
  // The waiting points must be one unbroken run that ends at the phone's score.
  if (last !== i.localNo || pending.length !== last - first + 1) return "ask";
  if (first === i.serverNo + 1) return "local";
  if (first > i.serverNo + 1) return covers(i.serverNo + 1, first - 1) ? "local" : "ask";
  // The server already has events with these numbers: fine only if they are this phone's.
  const atServer = have.get(i.serverNo);
  return i.serverNo <= i.localNo && atServer !== undefined && sameState(atServer.state, i.serverState) ? "local" : "ask";
}

/* ---------------- scoring v2: which timer follows, which stops first ---------------- */

export interface FeatureSwitches {
  timerBetweenPoints: boolean;
  timerChangeover: boolean;
  timerSetBreak: boolean;
}

/**
 * The timer a step that moved the score starts: a changeover or set break is
 * recorded (TIMER_STARTED, shown on screens); the 25 s between points runs on the
 * console only (an overrun the referee rules on is recorded as TIME_DECISION).
 * A switched-off changeover or set break falls back to the 25 s when that is on.
 */
export function followingTimer(after: AfterPoint | undefined, f: FeatureSwitches): { kind: TimerKind; record: boolean } | null {
  if (!after?.timer) return null;
  if (after.timer === "changeover" && f.timerChangeover) return { kind: "changeover", record: true };
  if (after.timer === "set_break" && f.timerSetBreak) return { kind: "set_break", record: true };
  return f.timerBetweenPoints ? { kind: "between_points", record: false } : null;
}

/** The recorded timer still running in this state (it must be stopped before the next scoring action), or null. */
export function runningClock(s: ScoreState | null): { kind: TimerKind; startedAt: string; team: TeamKey | null } | null {
  const c = s?.clock;
  if (!s || !c || c.kind === "between_points") return null;
  return { kind: c.kind as TimerKind, startedAt: c.startedAt, team: c.team ?? null };
}
