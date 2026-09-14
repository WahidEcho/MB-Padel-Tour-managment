/**
 * What the voice umpire says, as clip ids. Pure: no audio, no timers, no DOM.
 *
 * Every call is phrased from the server's side, which is the side serving the
 * next point: "Thirty fifteen" means the server has thirty. Sides are never named
 * — they are "server" and "receiver" — because a recorded voice cannot say an
 * arbitrary team name reliably.
 *
 * A call describes the net change across the few seconds before it is spoken,
 * not the last tap: a point and its undo inside that window cancel out, three
 * quick taps are called as the score they leave, and "Correction" is said only
 * when an undo reaches back past the score last spoken. Whenever the server is unknown
 * (a tie-break saved before the engine tracked its rotation), the voice stays
 * silent rather than read a score backwards.
 *
 * Nothing here throws. A score the inventory cannot phrase is simply not called.
 */
import {
  awardPoint,
  currentServer,
  manualEndSet,
  opponent,
  pointOutcome,
  type ScoreState,
  type TeamKey,
  type TeamScore,
} from "../scoring/engine";
import type { ScoringConfig } from "../types";
import { MAX_GAMES_PHRASE, MAX_NUMBER, MAX_TIEBREAK_PHRASE, PHRASES, type ClipId } from "./phrases";

export type VoiceEventKind = "scoring" | "passive" | "terminal";

/**
 * How a referee event affects a pending call.
 * - scoring: changes the score; stops any call and restarts the wait.
 * - passive: updates the score a pending call will read, but never starts a call
 *   or cuts one off — so confirming a result straight away still lets
 *   "Game, set and match" play.
 * - terminal: ends the match outside the rules of scoring; nothing is said.
 */
export function classifyEvent(eventType: string): VoiceEventKind {
  switch (eventType) {
    case "POINT_AWARDED":
    case "UNDO":
    case "MANUAL_SET_END":
      return "scoring";
    case "FORCE_END":
    case "WALKOVER":
    case "RETIREMENT":
    case "DISQUALIFICATION":
      return "terminal";
    default:
      return "passive";
  }
}

function side(state: ScoreState, team: TeamKey): TeamScore {
  return team === "A" ? state.teamA : state.teamB;
}

/**
 * Only the numbers on the board, finished sets included. The server is
 * deliberately left out. Finished sets are compared by their scores, not just
 * counted: a set won on a point (6-4) and the same set ended by hand at 5-4 leave
 * the same fresh board behind, and only their final score tells them apart.
 */
export function sameScore(a: ScoreState, b: ScoreState): boolean {
  const same = (x: TeamScore, y: TeamScore) =>
    x.points === y.points && x.games === y.games && x.sets === y.sets && x.tiebreakPoints === y.tiebreakPoints;
  return (
    same(a.teamA, b.teamA) &&
    same(a.teamB, b.teamB) &&
    a.isTiebreak === b.isTiebreak &&
    a.currentSet === b.currentSet &&
    a.matchOver === b.matchOver &&
    a.completedSets.length === b.completedSets.length &&
    a.completedSets.every((set, i) => {
      const other = b.completedSets[i];
      return (
        set.teamAGames === other.teamAGames &&
        set.teamBGames === other.teamBGames &&
        set.tiebreak?.a === other.tiebreak?.a &&
        set.tiebreak?.b === other.tiebreak?.b
      );
    })
  );
}

/** A number spoken as words, or null past the inventory. */
function numberClips(n: number): ClipId[] | null {
  return Number.isInteger(n) && n >= 0 && n <= MAX_NUMBER ? [`n-${n}`] : null;
}

/** "Thirty fifteen", "Deuce", "Advantage receiver". Null when the server is unknown. */
export function pointsPhrase(state: ScoreState): ClipId[] | null {
  const server = currentServer(state);
  if (!server || state.isTiebreak) return null;
  const s = side(state, server).points;
  const r = side(state, opponent(server)).points;
  if (s === "AD") return ["adv-server"];
  if (r === "AD") return ["adv-receiver"];
  return [`pts-${s}-${r}`];
}

/** "Three two", "Four all", or built from number words past the whole phrases. */
export function tiebreakNumbers(state: ScoreState): ClipId[] | null {
  const server = currentServer(state);
  if (!server || !state.isTiebreak) return null;
  const s = side(state, server).tiebreakPoints;
  const r = side(state, opponent(server)).tiebreakPoints;
  if (s <= MAX_TIEBREAK_PHRASE && r <= MAX_TIEBREAK_PHRASE) return [`tb-${s}-${r}`];
  const sClips = numberClips(s);
  if (!sClips) return null;
  if (s === r) return [...sClips, "all"];
  const rClips = numberClips(r);
  return rClips ? [...sClips, ...rClips] : null;
}

/**
 * "Server leads four games to two", "Three games all". Relative to whoever serves
 * the next point. Null at love all, where there is nothing to tally.
 */
export function gamesTally(state: ScoreState): ClipId[] | null {
  const server = currentServer(state);
  if (!server) return null;
  const g = side(state, server).games;
  const h = side(state, opponent(server)).games;
  if (g === 0 && h === 0) return null;
  if (g === h) {
    if (g <= MAX_GAMES_PHRASE) return [`games-all-${g}`];
    const n = numberClips(g);
    return n ? [...n, "games-all"] : null;
  }
  const lead: ClipId = g > h ? "leads-server" : "leads-receiver";
  const hi = Math.max(g, h);
  const lo = Math.min(g, h);
  if (hi <= MAX_GAMES_PHRASE) return [lead, `games-${hi}-${lo}`];
  const hiClips = numberClips(hi);
  const loClips = lo === 0 ? ["love"] : numberClips(lo);
  return hiClips && loClips ? [lead, ...hiClips, "games-to", ...loClips] : null;
}

/** "Receiver leads one set to love", "One set all". Null past best of five. */
export function setsTally(state: ScoreState): ClipId[] | null {
  const server = currentServer(state);
  if (!server) return null;
  const s = side(state, server).sets;
  const r = side(state, opponent(server)).sets;
  if (s === r) return s >= 1 && `sets-all-${s}` in PHRASES ? [`sets-all-${s}`] : null;
  const id = `sets-${Math.max(s, r)}-${Math.min(s, r)}`;
  if (!(id in PHRASES)) return null;
  return [s > r ? "leads-server" : "leads-receiver", id];
}

/**
 * "Match point", "Set point" or "Break point" when the next point could decide
 * it, for either side. The biggest one wins, and a tie-break has no break point.
 */
export function bigPoint(state: ScoreState, config: ScoringConfig): ClipId | null {
  const server = currentServer(state);
  if (!server || state.matchOver) return null;
  const forServer = pointOutcome(state, server, config);
  const forReceiver = pointOutcome(state, opponent(server), config);
  if (forServer.winsMatch || forReceiver.winsMatch) return "match-point";
  if (forServer.winsSet || forReceiver.winsSet) return "set-point";
  if (!state.isTiebreak && forReceiver.winsGame) return "break-point";
  return null;
}

function totalGames(state: ScoreState): number {
  return state.teamA.games + state.teamB.games;
}

function withBigPoint(call: ClipId[] | null, state: ScoreState, config: ScoringConfig): ClipId[] | null {
  if (!call) return null;
  const big = bigPoint(state, config);
  return big ? [...call, big] : call;
}

/** The call for exactly one point won, from `from` to `to`. */
export function pointCall(from: ScoreState, to: ScoreState, config: ScoringConfig): ClipId[] | null {
  if (to.matchOver) return ["game-set-match"];
  if (to.completedSets.length > from.completedSets.length) {
    return withBigPoint(["game-and-set", ...(setsTally(to) ?? [])], to, config);
  }
  if (!from.isTiebreak && to.isTiebreak) {
    const tally = gamesTally(to);
    return withBigPoint(["game", ...(tally ?? []), "tie-break"], to, config);
  }
  if (to.isTiebreak) return withBigPoint(tiebreakNumbers(to), to, config);
  if (totalGames(to) !== totalGames(from)) {
    return withBigPoint(["game", ...(gamesTally(to) ?? [])], to, config);
  }
  return withBigPoint(pointsPhrase(to), to, config);
}

/**
 * The whole standing score, for a correction or a burst of taps: the sets and
 * games tallies when those changed since the last call, then the points.
 */
export function standingCall(from: ScoreState, to: ScoreState, config: ScoringConfig): ClipId[] | null {
  if (to.matchOver) return ["game-set-match"];
  if (!currentServer(to)) return null;
  const parts: ClipId[] = [];
  const setChanged = from.completedSets.length !== to.completedSets.length || from.currentSet !== to.currentSet;
  if (setChanged) parts.push(...(setsTally(to) ?? []));
  if (setChanged || totalGames(from) !== totalGames(to) || from.isTiebreak !== to.isTiebreak) {
    parts.push(...(gamesTally(to) ?? []));
  }
  const points = to.isTiebreak ? tiebreakNumbers(to) : pointsPhrase(to);
  if (!points) return null;
  parts.push(...points);
  return withBigPoint(parts, to, config);
}

export interface TransitionInfo {
  /**
   * An undo took the score back past the last call, so what was said is being
   * taken back. An undo that only cancels a tap made since the last call is not a
   * correction: nobody heard that tap.
   */
  corrects: boolean;
  /**
   * Points and manual set ends minus undos inside the window. It separates a real
   * point from an undo that lands on the same board: undoing "Advantage server"
   * gives deuce, exactly as if the receiver had scored, but only one of them is a
   * correction.
   */
  netPoints: number;
}

/**
 * What to say for the change from the last spoken score to the current one.
 * Null means say nothing.
 */
export function callForTransition(
  from: ScoreState,
  to: ScoreState,
  info: TransitionInfo,
  config: ScoringConfig,
): ClipId[] | null {
  try {
    if (sameScore(from, to)) return null;
    if (info.netPoints === 1 && !from.matchOver) {
      for (const team of ["A", "B"] as TeamKey[]) {
        if (sameScore(awardPoint(from, team, config), to)) return valid(pointCall(from, to, config));
      }
      for (const team of ["A", "B"] as TeamKey[]) {
        if (sameScore(manualEndSet(from, team, config), to)) {
          return valid(to.matchOver ? ["game-set-match"] : ["set", ...(setsTally(to) ?? [])]);
        }
      }
    }
    const standing = standingCall(from, to, config);
    if (!standing) return null;
    return valid(info.corrects ? ["correction", ...standing] : standing);
  } catch {
    return null;
  }
}

/** Refuses a call that asks for a clip the inventory does not have. */
function valid(call: ClipId[] | null): ClipId[] | null {
  if (!call || call.length === 0) return null;
  return call.every((id) => id in PHRASES) ? call : null;
}
