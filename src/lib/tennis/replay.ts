/**
 * Replays a known result point by point: the real score line of a rubber
 * ("6-4 6-3", "7-6(5) 3-6 [10-8]") turned into a plausible sequence of points
 * that, played through the scoring engine, ends on exactly that score.
 *
 * A demo uses it to put real finals back on the court TVs — walk-ons, callouts,
 * changeovers and all — through the same events a referee's phone sends. Only
 * the set scores are real; the order of the games and the points inside them
 * are invented, varied by a seed so no two games look alike. Pure.
 */
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../scoring/engine";
import type { ScoringConfig } from "../types";

/** One set of a result line, from team A's side. */
export interface ResultSet {
  a: number;
  b: number;
  /** A tie-break set: the loser's tie-break points, as written in 7-6(5). */
  tiebreakLoser?: number;
  /** A match tie-break in place of the final set: its points, a-b. */
  matchTiebreak?: boolean;
}

/**
 * Reads a score line from team A's side: sets separated by spaces, a tie-break
 * set as 7-6(5), a match tie-break as [10-8]. Null when the line is not one.
 */
export function parseResult(line: string): ResultSet[] | null {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const sets: ResultSet[] = [];
  for (const p of parts) {
    const mtb = /^\[(\d+)-(\d+)\]$/.exec(p);
    if (mtb) {
      sets.push({ a: Number(mtb[1]), b: Number(mtb[2]), matchTiebreak: true });
      continue;
    }
    const m = /^(\d+)-(\d+)(?:\((\d+)\))?$/.exec(p);
    if (!m) return null;
    sets.push({ a: Number(m[1]), b: Number(m[2]), ...(m[3] !== undefined ? { tiebreakLoser: Number(m[3]) } : {}) });
  }
  return sets;
}

/** A small seeded generator, so a replay is the same every time it is built. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Points of one game won by `w`: to love, fifteen, thirty, or through deuce —
 * where no-ad ends it on the deciding point, and advantage may go round again.
 */
function gamePoints(w: TeamKey, rand: () => number, decidingPoint: boolean): TeamKey[] {
  const l: TeamKey = w === "A" ? "B" : "A";
  const r = rand();
  const lost = r < 0.2 ? 0 : r < 0.5 ? 1 : r < 0.78 ? 2 : 3;
  if (lost < 3) {
    // The loser's points fall anywhere before the winner's last one.
    const early: TeamKey[] = [w, w, w, ...Array<TeamKey>(lost).fill(l)];
    for (let i = early.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [early[i], early[j]] = [early[j], early[i]];
    }
    return [...early, w];
  }
  const toDeuce: TeamKey[] = rand() < 0.5 ? [w, l, w, l, w, l] : [l, l, w, w, l, w];
  if (decidingPoint) return [...toDeuce, w];
  const extra = rand() < 0.35 ? (rand() < 0.5 ? [w, l] : [l, w]) : [];
  return [...toDeuce, ...extra, w, w];
}

/** Tie-break points ending w-l for the winner: level as long as the loser scores, then the winner pulls away. */
function tiebreakPoints(w: TeamKey, won: number, lost: number, rand: () => number): TeamKey[] {
  const l: TeamKey = w === "A" ? "B" : "A";
  const out: TeamKey[] = [];
  for (let i = 0; i < lost; i++) out.push(...(rand() < 0.5 ? [w, l] : [l, w]));
  for (let i = lost; i < won; i++) out.push(w);
  return out;
}

/**
 * The order the games of a set were won in: level for as long as the loser
 * keeps up, with a few seeded swaps, never ending the set early.
 */
function gameOrder(w: TeamKey, won: number, lost: number, rand: () => number, gamesToWin: number): TeamKey[] {
  const l: TeamKey = w === "A" ? "B" : "A";
  const order: TeamKey[] = [];
  for (let i = 0; i < lost; i++) order.push(w, l);
  for (let i = lost; i < won; i++) order.push(w);
  const valid = (seq: TeamKey[]) => {
    let gw = 0;
    let gl = 0;
    for (let i = 0; i < seq.length - 1; i++) {
      if (seq[i] === w) gw++;
      else gl++;
      const over = (x: number, y: number) => (x >= gamesToWin && x - y >= 2) || x > gamesToWin;
      if (over(gw, gl) || over(gl, gw)) return false;
    }
    return true;
  };
  for (let n = 0; n < lost * 2; n++) {
    const i = Math.floor(rand() * (order.length - 2));
    const swapped = [...order];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    if (valid(swapped)) order.splice(0, order.length, ...swapped);
  }
  return order;
}

export interface Replay {
  points: TeamKey[];
  /** Every state from the first serve to the last point, as the engine scores them. */
  states: ScoreState[];
}

/**
 * The points of a result, checked against the engine: the replay ends exactly on
 * the result line, or this throws — a demo must never show a score that was not.
 */
export function replayResult(line: string, config: ScoringConfig, seed = 1, firstServer: TeamKey = "A"): Replay {
  const sets = parseResult(line);
  if (!sets) throw new Error(`Not a score line: "${line}"`);
  const rand = rng(seed);
  const points: TeamKey[] = [];
  const target = config.tiebreakAtGames ?? config.gamesToWinSet;
  for (const set of sets) {
    const w: TeamKey = set.a > set.b ? "A" : "B";
    const won = Math.max(set.a, set.b);
    const lost = Math.min(set.a, set.b);
    if (set.matchTiebreak) {
      points.push(...tiebreakPoints(w, won, lost, rand));
      continue;
    }
    const tiebreak = set.tiebreakLoser !== undefined || (config.tiebreakEnabled && lost === target && won === target + 1);
    if (tiebreak) {
      const l: TeamKey = w === "A" ? "B" : "A";
      for (let i = 0; i < target; i++) {
        for (const g of i % 2 ? [l, w] : [w, l]) points.push(...gamePoints(g, rand, Boolean(config.decidingPoint)));
      }
      const tbLost = set.tiebreakLoser ?? Math.floor(rand() * (config.tiebreakTargetPoints - 1));
      const tbWon = Math.max(config.tiebreakTargetPoints, tbLost + 2);
      points.push(...tiebreakPoints(w, tbWon, tbLost, rand));
      continue;
    }
    for (const g of gameOrder(w, won, lost, rand, config.gamesToWinSet)) {
      points.push(...gamePoints(g, rand, Boolean(config.decidingPoint)));
    }
  }

  let s = initialScoreState(firstServer);
  const states = [s];
  for (const p of points) {
    if (s.matchOver) throw new Error(`"${line}" ends before its last set under these rules`);
    s = awardPoint(s, p, config);
    states.push(s);
  }
  const got = s.completedSets.map((c) => (c.matchTiebreak && c.tiebreak ? `[${c.tiebreak.a}-${c.tiebreak.b}]` : `${c.teamAGames}-${c.teamBGames}`));
  const want = sets.map((x) => (x.matchTiebreak ? `[${x.a}-${x.b}]` : `${x.a}-${x.b}`));
  if (!s.matchOver || got.join(" ") !== want.join(" ")) {
    throw new Error(`"${line}" does not replay under these rules (got ${got.join(" ") || "nothing"})`);
  }
  return { points, states };
}

/** The result line from the winner's side flipped to team A's side, when the winner is team B. */
export function fromSideA(line: string, winner: TeamKey): string {
  if (winner === "A") return line.trim();
  return line
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/^(\[?)(\d+)-(\d+)/, "$1$3-$2"))
    .join(" ");
}
