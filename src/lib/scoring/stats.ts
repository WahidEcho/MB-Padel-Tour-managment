/**
 * Match and tie statistics for fans: aces, double faults, break points, points won
 * (in all, on serve, on return), games won, the longest run of points and how long
 * the match (and each set) took. Per side; a doubles rubber counts per team.
 *
 * Pure (no database, no framework): shared by the server (src/lib/mobile/stats.ts,
 * behind GET /api/mobile/v1/matches/[matchId]/stats and /ties/[tieId]/stats), the
 * public web match page and the Move Score app (through @core).
 *
 * The source is the match's stored score events, oldest first. An event a later
 * Undo took back does not count (the same undo stack as the match log: every event
 * that stored the state before it, except the log-only timers). For each point the
 * stored state BEFORE it says who served (`currentServer`) and whether the receiver
 * was one point from the game (`pointOutcome`, with this match's rules: a no-ad
 * deciding point at deuce is a break point, a tie-break point never is).
 *
 * Only POINT_AWARDED events are points here (aces and double faults included); a
 * penalty point or game (code violation) moves the score but is not a point played.
 * A result entered as a final score (RESULT_ENTERED, or a correction) has no points
 * behind it: its stats are unavailable ("Recorded point by point only").
 */
import { currentServer, initialScoreState, opponent, pointOutcome, totalGames, type ScoreState, type TeamKey } from "./engine";
import { pushesHistory } from "./eventGuard";
import type { ScoringConfig } from "../types";

/** One stored score event, as the server reads it. `prev` is the stored state before it (or the part of it stats need). */
export interface StatsEventRow {
  event_number: number;
  event_type: string;
  team_id: string | null;
  payload: Record<string, unknown> | null;
  /** previous_state_json, or a projection with teamA, teamB, isTiebreak, isMatchTiebreak, servingTeam, tiebreakFirstServer, currentSet. */
  prev: unknown;
  /** When the device recorded it (created_at_client), else when the server stored it. */
  at: string | null;
  /** sync_status = 'superseded': replaced by a final result entered later. */
  superseded?: boolean;
}

export interface SideStats {
  /** Absent when the organiser hides aces ("Show aces on TV & app" off). */
  aces?: number;
  doubleFaults: number;
  /** Break points this side converted as the receiver. */
  breakPointsWon: number;
  /** Break points this side had as the receiver. */
  breakPointChances: number;
  pointsWon: number;
  servicePointsWon: number;
  servicePointsPlayed: number;
  returnPointsWon: number;
  returnPointsPlayed: number;
  gamesWon: number;
  /** Most points this side won in a row. */
  longestRun: number;
}

export interface SetDuration {
  set: number;
  /** "Set 2", or "Match tie-break" for one played in place of the final set. */
  label: string;
  startedAt: string | null;
  endedAt: string | null;
  seconds: number | null;
}

export interface MatchStats {
  available: true;
  sides: { A: SideStats; B: SideStats };
  /** Points played (counted). */
  points: number;
  /** First point to last point, breaks included. Null when the times are unknown. */
  durationSeconds: number | null;
  startedAt: string | null;
  endedAt: string | null;
  sets: SetDuration[];
  /** Whether `aces` is in the sides (the organiser's switch). */
  aces: boolean;
}

export type StatsUnavailableReason = "final_score" | "no_points" | "unsupported";

export interface StatsUnavailable {
  available: false;
  reason: StatsUnavailableReason;
  /** One line for fans. */
  note: string;
}

export type MatchStatsResult = MatchStats | StatsUnavailable;

export const STATS_NOTES: Record<StatsUnavailableReason, string> = {
  final_score: "Recorded point by point only. This result was entered as a final score.",
  no_points: "Stats appear once the first point is played.",
  unsupported: "Stats are not kept for this sport.",
};

export function statsUnavailable(reason: StatsUnavailableReason): StatsUnavailable {
  return { available: false, reason, note: STATS_NOTES[reason] };
}

export interface MatchStatsOptions {
  teamA: string | null;
  teamB: string | null;
  /** The rules this match is played under (scoringConfigForMatch). */
  config: ScoringConfig;
  /** The match's current state (its snapshot), for games won. Without it games are counted from the points. */
  final?: ScoreState | null;
  /** The organiser shows aces (`tvAces` and `ace` on). */
  showAces: boolean;
  /** matches.result_source: "final_score" or "correction" means no point-by-point stats. */
  resultSource?: string | null;
}

type Prev = Pick<ScoreState, "teamA" | "teamB" | "isTiebreak" | "servingTeam"> & Partial<ScoreState>;

function asPrev(v: unknown): Prev | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<ScoreState>;
  if (!o.teamA || !o.teamB || typeof o.teamA !== "object" || typeof o.teamB !== "object") return null;
  return o as Prev;
}

/** A full ScoreState around a stored (possibly projected) one, enough for the engine's point outcome. */
function fullState(p: Prev): ScoreState {
  const base = initialScoreState(p.servingTeam ?? "A");
  const team = (t: Partial<ScoreState["teamA"]>) => ({
    points: t.points ?? "0",
    games: Number(t.games ?? 0),
    sets: Number(t.sets ?? 0),
    tiebreakPoints: Number(t.tiebreakPoints ?? 0),
  });
  return {
    ...base,
    currentSet: Number(p.currentSet ?? 1),
    teamA: team(p.teamA),
    teamB: team(p.teamB),
    isTiebreak: p.isTiebreak === true,
    isMatchTiebreak: p.isMatchTiebreak === true ? true : undefined,
    servingTeam: p.servingTeam ?? null,
    tiebreakFirstServer: p.tiebreakFirstServer ?? null,
    completedSets: [],
    matchOver: false,
    winner: null,
  };
}

function emptySide(showAces: boolean): SideStats {
  return {
    ...(showAces ? { aces: 0 } : {}),
    doubleFaults: 0,
    breakPointsWon: 0,
    breakPointChances: 0,
    pointsWon: 0,
    servicePointsWon: 0,
    servicePointsPlayed: 0,
    returnPointsWon: 0,
    returnPointsPlayed: 0,
    gamesWon: 0,
    longestRun: 0,
  };
}

function seconds(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}

/** The events that count: not superseded, not taken back by an Undo. Oldest first. */
export function effectiveEvents<T extends StatsEventRow>(rows: T[]): T[] {
  const sorted = [...rows].sort((x, y) => x.event_number - y.event_number);
  const undone = new Set<T>();
  const stack: T[] = [];
  for (const r of sorted) {
    if (r.event_type === "UNDO") {
      const target = stack.pop();
      if (target) undone.add(target);
      continue;
    }
    if (r.event_type === "RESULT_ENTERED") stack.length = 0;
    else if (pushesHistory(r.event_type) && r.prev) stack.push(r);
  }
  return sorted.filter((r) => !undone.has(r) && !r.superseded && r.event_type !== "UNDO");
}

/** The statistics of one match from its stored score events. */
export function computeMatchStats(rows: StatsEventRow[], o: MatchStatsOptions): MatchStatsResult {
  if (o.resultSource === "final_score" || o.resultSource === "correction") return statsUnavailable("final_score");
  if (rows.some((r) => r.event_type === "RESULT_ENTERED" || r.superseded)) return statsUnavailable("final_score");
  const keyOf = (id: string | null): TeamKey | null => (id && id === o.teamA ? "A" : id && id === o.teamB ? "B" : null);
  const sides = { A: emptySide(o.showAces), B: emptySide(o.showAces) };
  const run = { side: null as TeamKey | null, n: 0 };
  const setTimes = new Map<number, { label: string; first: string | null; last: string | null }>();
  let points = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  const countedGames = { A: 0, B: 0 };

  for (const r of effectiveEvents(rows)) {
    if (r.event_type !== "POINT_AWARDED") continue;
    const winner = keyOf(r.team_id);
    if (!winner) continue;
    const loser = opponent(winner);
    const p = r.payload ?? {};
    const prevRaw = asPrev(r.prev);
    const prev = prevRaw ? fullState(prevRaw) : null;
    points += 1;
    sides[winner].pointsWon += 1;
    if (run.side === winner) run.n += 1;
    else {
      run.side = winner;
      run.n = 1;
    }
    sides[winner].longestRun = Math.max(sides[winner].longestRun, run.n);
    if (p.ace === true && sides[winner].aces !== undefined) sides[winner].aces! += 1;
    if (p.double_fault === true) sides[loser].doubleFaults += 1;

    if (r.at) {
      firstAt ??= r.at;
      lastAt = r.at;
    }
    if (prev) {
      const server = currentServer(prev);
      if (server) {
        const receiver = opponent(server);
        sides[server].servicePointsPlayed += 1;
        sides[receiver].returnPointsPlayed += 1;
        if (winner === server) sides[server].servicePointsWon += 1;
        else sides[receiver].returnPointsWon += 1;
        // A break point: the receiver wins the game with this point. Never in a tie-break.
        if (!prev.isTiebreak && pointOutcome(prev, receiver, o.config).winsGame) {
          sides[receiver].breakPointChances += 1;
          if (winner === receiver) sides[receiver].breakPointsWon += 1;
        }
      }
      if (pointOutcome(prev, winner, o.config).winsGame) countedGames[winner] += 1;
      const set = prev.currentSet;
      const t = setTimes.get(set) ?? { label: prev.isMatchTiebreak ? "Match tie-break" : `Set ${set}`, first: null, last: null };
      if (r.at) {
        t.first ??= r.at;
        t.last = r.at;
      }
      setTimes.set(set, t);
    }
  }
  if (!points) return statsUnavailable("no_points");
  const games = o.final ? totalGames(o.final) : { a: countedGames.A, b: countedGames.B };
  sides.A.gamesWon = games.a;
  sides.B.gamesWon = games.b;
  return {
    available: true,
    sides,
    points,
    durationSeconds: seconds(firstAt, lastAt),
    startedAt: firstAt,
    endedAt: lastAt,
    sets: [...setTimes.entries()]
      .sort(([a], [b]) => a - b)
      .map(([set, t]) => ({ set, label: t.label, startedAt: t.first, endedAt: t.last, seconds: seconds(t.first, t.last) })),
    aces: o.showAces,
  };
}

/**
 * Who won each point, oldest first (the counted points only: POINT_AWARDED events
 * neither undone nor superseded, by the match's own sides). The broadcast
 * overlay's momentum line draws the last forty of these.
 */
export function pointWinners(rows: StatsEventRow[], teamA: string | null, teamB: string | null): TeamKey[] {
  const out: TeamKey[] = [];
  for (const r of effectiveEvents(rows)) {
    if (r.event_type !== "POINT_AWARDED" || !r.team_id) continue;
    if (r.team_id === teamA) out.push("A");
    else if (r.team_id === teamB) out.push("B");
  }
  return out;
}

/* ---------------- ties ---------------- */

export interface TieRubberStats {
  matchId: string;
  rubberNo: number | null;
  rubberType: string | null;
  /** This rubber's stats with the tie's side A on the left (sides swapped where the rubber lists the teams the other way). */
  stats: MatchStatsResult;
}

export interface TieStats {
  /** Any rubber recorded point by point. */
  available: boolean;
  /** Sums over the rubbers recorded point by point (longest run: the longest in any of them). */
  sides: { A: SideStats; B: SideStats } | null;
  points: number;
  /** Time on court: each counted rubber's first point to its last, added up. */
  timeOnCourtSeconds: number | null;
  /** Rubbers whose stats are in the sums. */
  counted: number;
  aces: boolean;
  rubbers: TieRubberStats[];
  note: string | null;
}

/** The stats of a match seen from the other side. */
export function swapSides(s: MatchStatsResult): MatchStatsResult {
  return s.available ? { ...s, sides: { A: s.sides.B, B: s.sides.A } } : s;
}

function addSide(x: SideStats, y: SideStats): SideStats {
  const out: SideStats = {
    doubleFaults: x.doubleFaults + y.doubleFaults,
    breakPointsWon: x.breakPointsWon + y.breakPointsWon,
    breakPointChances: x.breakPointChances + y.breakPointChances,
    pointsWon: x.pointsWon + y.pointsWon,
    servicePointsWon: x.servicePointsWon + y.servicePointsWon,
    servicePointsPlayed: x.servicePointsPlayed + y.servicePointsPlayed,
    returnPointsWon: x.returnPointsWon + y.returnPointsWon,
    returnPointsPlayed: x.returnPointsPlayed + y.returnPointsPlayed,
    gamesWon: x.gamesWon + y.gamesWon,
    longestRun: Math.max(x.longestRun, y.longestRun),
  };
  if (x.aces !== undefined || y.aces !== undefined) out.aces = (x.aces ?? 0) + (y.aces ?? 0);
  return out;
}

/** Tie stats: the sum over its rubbers (already oriented to the tie's sides) plus the total time on court. */
export function tieStats(rubbers: TieRubberStats[], showAces: boolean): TieStats {
  const done = rubbers.map((r) => r.stats).filter((s): s is MatchStats => s.available);
  if (!done.length) {
    const finalOnly = rubbers.some((r) => !r.stats.available && r.stats.reason === "final_score");
    return {
      available: false,
      sides: null,
      points: 0,
      timeOnCourtSeconds: null,
      counted: 0,
      aces: showAces,
      rubbers,
      note: finalOnly ? STATS_NOTES.final_score : STATS_NOTES.no_points,
    };
  }
  let A = emptySide(showAces);
  let B = emptySide(showAces);
  let time: number | null = null;
  let points = 0;
  for (const s of done) {
    A = addSide(A, s.sides.A);
    B = addSide(B, s.sides.B);
    points += s.points;
    if (s.durationSeconds !== null) time = (time ?? 0) + s.durationSeconds;
  }
  const skipped = rubbers.some((r) => !r.stats.available && r.stats.reason === "final_score");
  return {
    available: true,
    sides: { A, B },
    points,
    timeOnCourtSeconds: time,
    counted: done.length,
    aces: showAces,
    rubbers,
    note: skipped ? "Rubbers entered as a final score are not in these numbers (recorded point by point only)." : null,
  };
}

/* ---------------- what the screens draw ---------------- */

export interface StatLine {
  key: string;
  label: string;
  a: string;
  b: string;
  /** Bar lengths, 0..1: a count against the larger of the two, a percentage as itself. */
  aBar: number;
  bBar: number;
  /** The side ahead on this line (fewer is better for double faults), or null when level. */
  lead: TeamKey | null;
}

const pct = (won: number, of: number) => (of ? Math.round((won / of) * 100) : 0);

function countLine(key: string, label: string, a: number, b: number, fewerIsBetter = false): StatLine {
  const max = Math.max(a, b);
  const lead = a === b ? null : (a > b) !== fewerIsBetter ? "A" : "B";
  return { key, label, a: String(a), b: String(b), aBar: max ? a / max : 0, bBar: max ? b / max : 0, lead };
}

function ratioLine(key: string, label: string, aw: number, ao: number, bw: number, bo: number, showPct: boolean): StatLine {
  const ap = ao ? aw / ao : 0;
  const bp = bo ? bw / bo : 0;
  const text = (w: number, of: number) => (showPct ? `${w}/${of} · ${pct(w, of)}%` : `${w}/${of}`);
  // Break points: who converted more; serve and return: the better rate.
  const lead = showPct ? (ap === bp ? null : ap > bp ? "A" : "B") : aw === bw ? null : aw > bw ? "A" : "B";
  const max = Math.max(aw, bw);
  return {
    key,
    label,
    a: text(aw, ao),
    b: text(bw, bo),
    aBar: showPct ? ap : max ? aw / max : 0,
    bBar: showPct ? bp : max ? bw / max : 0,
    lead,
  };
}

/** The rows of the Stats card, top to bottom. Aces only when the organiser shows them. */
export function statLines(sides: { A: SideStats; B: SideStats }): StatLine[] {
  const { A, B } = sides;
  const lines: StatLine[] = [];
  if (A.aces !== undefined && B.aces !== undefined) lines.push(countLine("aces", "Aces", A.aces, B.aces));
  lines.push(countLine("doubleFaults", "Double faults", A.doubleFaults, B.doubleFaults, true));
  lines.push(ratioLine("breakPoints", "Break points won", A.breakPointsWon, A.breakPointChances, B.breakPointsWon, B.breakPointChances, false));
  lines.push(countLine("pointsWon", "Points won", A.pointsWon, B.pointsWon));
  lines.push(ratioLine("servicePoints", "Won on serve", A.servicePointsWon, A.servicePointsPlayed, B.servicePointsWon, B.servicePointsPlayed, true));
  lines.push(ratioLine("returnPoints", "Won on return", A.returnPointsWon, A.returnPointsPlayed, B.returnPointsWon, B.returnPointsPlayed, true));
  lines.push(countLine("gamesWon", "Games won", A.gamesWon, B.gamesWon));
  lines.push(countLine("longestRun", "Longest run of points", A.longestRun, B.longestRun));
  return lines;
}

/** "1h 24m", "38m", "45s". */
export function durationText(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.max(0, Math.round(s))}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
