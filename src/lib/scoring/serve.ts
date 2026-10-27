/**
 * Scoring v2: the serve. First and second serve, faults and double faults, aces,
 * lets, and in doubles who serves and who receives each point. Pure: shared by the
 * web console, the Move Score app (through @core) and the server, which re-derives
 * every v2 event's state with these functions before it stores it (append.ts).
 *
 * Everything lives in the ScoreState the events already carry, in fields a console
 * that does not know them (Move Score 1.0.1) copies along untouched:
 * - `serve` marks a first-serve fault at the score it happened. It is stale as soon
 *   as the score moves, so an old console scoring the next point can never leave a
 *   second serve behind.
 * - `stats` counts aces and double faults; `lastAce` lets screens flash "ACE".
 * - `doublesOrder` (engine.ts) and `receiveOrder` say which partner serves first and
 *   which receives in the deuce court, set at the start of every set (ITF Rule 14).
 *   Which TEAM serves first is the toss's at the first set only; later sets follow the
 *   rotation (`setServeOrder` refuses another team).
 */
import { awardPoint, currentServer, opponent, servingPlayer, type ScoreState, type TeamKey } from "./engine";
import type { ScoringConfig } from "../types";

const clone = (s: ScoreState): ScoreState => JSON.parse(JSON.stringify(s)) as ScoreState;

/** The score as one string: identical exactly when nothing on the board changed. */
export function scoreKey(s: ScoreState): string {
  return [
    s.completedSets.length,
    s.currentSet,
    `${s.teamA.sets}-${s.teamB.sets}`,
    `${s.teamA.games}-${s.teamB.games}`,
    `${s.teamA.points}-${s.teamB.points}`,
    `${s.teamA.tiebreakPoints}-${s.teamB.tiebreakPoints}`,
    s.matchOver ? "over" : "on",
  ].join("|");
}

/** 1 or 2: which serve the server is on. */
export function serveNumber(s: ScoreState): 1 | 2 {
  return s.serve?.fault === 1 && s.serve.at === scoreKey(s) && !s.matchOver ? 2 : 1;
}

function emptyStats(): NonNullable<ScoreState["stats"]> {
  return { aces: { A: 0, B: 0 }, doubleFaults: { A: 0, B: 0 } };
}

function bump(s: ScoreState, field: "aces" | "doubleFaults", team: TeamKey) {
  const stats = s.stats ? { aces: { ...s.stats.aces }, doubleFaults: { ...s.stats.doubleFaults } } : emptyStats();
  stats[field][team] += 1;
  s.stats = stats;
}

export interface FaultResult {
  next: ScoreState;
  /** The second fault: the point went to the receiver. */
  doubleFault: boolean;
  server: TeamKey;
}

/**
 * A fault by the server. The first one leaves the score and puts the server on a
 * second serve; the second is a double fault: the point goes to the receiver.
 * Null when the server is unknown or the match is over.
 */
export function fault(prev: ScoreState, config: ScoringConfig): FaultResult | null {
  const server = currentServer(prev);
  if (!server || prev.matchOver) return null;
  if (serveNumber(prev) === 1) {
    const next = clone(prev);
    next.serve = { fault: 1, at: scoreKey(prev) };
    return { next, doubleFault: false, server };
  }
  const next = awardPoint(prev, opponent(server), config);
  bump(next, "doubleFaults", server);
  return { next, doubleFault: true, server };
}

/** An ace: the point to the server, counted as an ace. Null when the server is unknown. */
export function ace(prev: ScoreState, config: ScoringConfig): { next: ScoreState; server: TeamKey } | null {
  const server = currentServer(prev);
  if (!server || prev.matchOver) return null;
  const next = awardPoint(prev, server, config);
  bump(next, "aces", server);
  next.lastAce = scoreKey(next);
  return { next, server };
}

export type LetKind = "serve" | "point";

/**
 * A let. "serve": that serve is played again, a second serve stays a second
 * serve. "point": the whole point is replayed from a first serve. The score
 * never changes.
 */
export function applyLet(prev: ScoreState, kind: LetKind): ScoreState {
  const next = clone(prev);
  if (kind === "point") delete next.serve;
  return next;
}

/** Whether the screens should show the "ACE" moment for this state. */
export function aceMoment(s: ScoreState | null | undefined): boolean {
  return Boolean(s && s.lastAce && s.lastAce === scoreKey(s));
}

/* ---------------- doubles: serve and receive order ---------------- */

export interface ServeOrder {
  /** The team serving the set's first game (in a match tie-break: its first point). */
  servingTeam: TeamKey;
  /** Which of that team's players serves first. */
  server: 0 | 1;
  /** Which player of the receiving team receives first (deuce court). */
  receiver: 0 | 1;
  /** Which player of the receiving team serves first, in game 2 (ITF Rule 14). */
  otherServer: 0 | 1;
  /** Which player of the serving team receives first, in game 2. */
  otherReceiver: 0 | 1;
}

/** The set has not started: no point, game or tie-break point played in it yet. */
export function atSetStart(s: ScoreState): boolean {
  return (
    !s.matchOver &&
    s.teamA.games === 0 &&
    s.teamB.games === 0 &&
    s.teamA.points === "0" &&
    s.teamB.points === "0" &&
    s.teamA.tiebreakPoints === 0 &&
    s.teamB.tiebreakPoints === 0
  );
}

/** Doubles: the console asks for the serve and receive order before the set's first point. */
export function needsServeOrder(s: ScoreState | null, doubles: boolean): boolean {
  return Boolean(s && doubles && atSetStart(s) && s.orderSet !== s.currentSet);
}

/**
 * The match's first set, before its first point: the toss decides which team serves
 * first, so the referee picks it. At every later set the serving team follows the
 * rotation (ITF Rule 14): the referee picks only which partner serves and receives.
 */
export function tossDecidesServer(s: ScoreState): boolean {
  return atSetStart(s) && s.currentSet === 1 && s.completedSets.length === 0;
}

/** The team the rotation has serving next (in a tie-break: its first point), or null when unknown. */
export function dueServingTeam(s: ScoreState): TeamKey | null {
  return (s.isTiebreak ? s.tiebreakFirstServer : s.servingTeam) ?? null;
}

/**
 * The order with the serving team the rotation gives, for a console whose form still
 * offers the team: each team keeps the partners it chose (who serves and who receives
 * first), only which of the two teams serves the set's first game is the rotation's.
 * Unchanged at the first set (the toss) or when the order already names the due team.
 */
export function lockServeOrder(s: ScoreState, o: ServeOrder): ServeOrder {
  const due = dueServingTeam(s);
  if (tossDecidesServer(s) || !due || o.servingTeam === due) return o;
  return { servingTeam: due, server: o.otherServer, receiver: o.otherReceiver, otherServer: o.server, otherReceiver: o.receiver };
}

/** The order the console offers: the rotation as it stands (who is due to serve). */
export function defaultServeOrder(s: ScoreState): ServeOrder {
  const team = dueServingTeam(s) ?? "A";
  const other = opponent(team);
  return {
    servingTeam: team,
    server: s.doublesOrder?.[team] ?? 0,
    receiver: s.receiveOrder?.[other] ?? 0,
    otherServer: s.doublesOrder?.[other] ?? 0,
    otherReceiver: s.receiveOrder?.[team] ?? 0,
  };
}

/**
 * Records the order for this set. Only at the start of a set; null otherwise. The
 * referee names the serving team at every set (owner, 27 Oct 2026): the console offers
 * the rotation's team (`dueServingTeam`) but a correction is the referee's call.
 * Doubles only: the caller (console, server) refuses it in singles.
 */
export function setServeOrder(prev: ScoreState, o: ServeOrder): ScoreState | null {
  if (!atSetStart(prev)) return null;
  const next = clone(prev);
  const team = o.servingTeam;
  const other = opponent(team);
  if (next.isTiebreak) next.tiebreakFirstServer = team;
  else next.servingTeam = team;
  next.setFirstServer = team;
  next.doublesOrder = { [team]: o.server, [other]: o.otherServer } as { A: 0 | 1; B: 0 | 1 };
  next.receiveOrder = { [other]: o.receiver, [team]: o.otherReceiver } as { A: 0 | 1; B: 0 | 1 };
  next.orderSet = next.currentSet;
  delete next.serve;
  return next;
}

const LABEL_N: Record<string, number> = { "0": 0, "15": 1, "30": 2, "40": 3, AD: 4 };

/** Points played in the current game (or tie-break); only its parity matters for the court. */
export function pointsInGame(s: ScoreState): number {
  if (s.isTiebreak) return s.teamA.tiebreakPoints + s.teamB.tiebreakPoints;
  return (LABEL_N[s.teamA.points] ?? 0) + (LABEL_N[s.teamB.points] ?? 0);
}

/** Which court the next point is served to: deuce (right) after an even number of points. */
export function serveCourt(s: ScoreState): "deuce" | "ad" {
  return pointsInGame(s) % 2 === 0 ? "deuce" : "ad";
}

/**
 * Doubles: who receives the next point. Each team keeps its receiving sides for
 * the whole set: the first receiver takes every point served to the deuce court,
 * the partner every point to the ad court (tie-breaks included). Null when the
 * server is unknown or the match is over. (At a no-ad deciding point the
 * receivers choose; this shows the deuce-court player.)
 */
export function receivingPlayer(s: ScoreState): { team: TeamKey; index: 0 | 1; court: "deuce" | "ad" } | null {
  const server = currentServer(s);
  if (!server) return null;
  const team = opponent(server);
  const first = s.receiveOrder?.[team] ?? 0;
  const court = serveCourt(s);
  return { team, index: (court === "deuce" ? first : 1 - first) as 0 | 1, court };
}

/**
 * The receiver to show a referee: the console asks only the side that receives first in a
 * set who receives (the other side chooses when it first receives), so for the team that
 * served the set's first game this is null rather than a guess.
 */
export function namedReceiver(s: ScoreState): { team: TeamKey; index: 0 | 1; court: "deuce" | "ad" } | null {
  const r = receivingPlayer(s);
  return r && s.setFirstServer && r.team === s.setFirstServer ? null : r;
}

export { servingPlayer };
