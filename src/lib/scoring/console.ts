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
  const ended = next.matchOver && !o.confirmFirst;
  return {
    eventType: "POINT_AWARDED",
    next,
    team,
    payload: null,
    newStatus: ended ? done(o.online, "completed") : undefined,
    ends: o.tennis ? endsChange(cur, next) : undefined,
  };
}

export function confirmResult(cur: ScoreState, o: ConsoleOptions): ConsoleEvent | null {
  if (!cur.matchOver || !cur.winner) return null;
  return { eventType: "MATCH_ENDED", next: cur, team: cur.winner, payload: {}, winner: cur.winner, newStatus: done(o.online, "completed") };
}

export function undo(history: ScoreState[], finished: boolean): ConsoleEvent | null {
  const prev = history[history.length - 1];
  if (!prev) return null;
  return { eventType: "UNDO", next: prev, team: null, payload: null, newStatus: finished ? "live" : undefined };
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
  const next: ScoreState = { ...cur, completedSets: [...cur.completedSets, ...extraSet], matchOver: true, winner };
  return { eventType: kind, next, team: winner, payload: {}, winner, newStatus: done(online, END_STATUS[kind]) };
}

/** The undo stack after an event, kept the way the web console keeps it (200 deep). */
export function nextHistory(history: ScoreState[], prev: ScoreState | null, eventType: string): ScoreState[] {
  return (eventType === "UNDO" ? history.slice(0, -1) : prev ? [...history, prev] : history).slice(-200);
}
