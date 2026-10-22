/**
 * The broadcast board's "Momentum · neon" rules, pure and framework-free.
 *
 * Owner's rule (22 Oct 2026): the board is COMPACT while play is on, and FULL
 * (momentum line + stat boxes) between games, between sets and once the match
 * is over. A game won opens the full board for the changeover or set-break timer
 * when one runs, else for GAME_HOLD_MS; the next point closes it. A finished
 * match stays full until the court's next match starts (overlayMatch decides
 * that). A running timer (changeover, set break, medical, warm-up…) keeps it
 * full until the timer ends or the next point.
 */
import type { TeamKey } from "../scoring/engine";
import type { OverlayModel } from "./overlay";

export type BoardMode = "compact" | "full";

/** How long the full board stays after a game won with no timer running. */
export const GAME_HOLD_MS = 20_000;
/** The momentum line covers this many points. */
export const MOMENTUM_POINTS = 40;

/** What the board remembers between frames. */
export interface BoardMemory {
  matchId: string;
  scoreKey: string;
  gamesPlayed: number;
  /** When a game was last won (and no point since); null otherwise. */
  gameWonAt: number | null;
}

/** One frame of the board: the mode to draw and what to remember for the next. */
export function boardStep(prev: BoardMemory | null, model: OverlayModel, now: number): { mode: BoardMode; memory: BoardMemory | null } {
  if (model.kind === "idle" || model.kind === "next") return { mode: "compact", memory: null };
  if (model.kind === "final") return { mode: "full", memory: null };

  let gameWonAt: number | null;
  if (!prev || prev.matchId !== model.matchId) {
    // A board that opens mid-match knows of no game just won.
    gameWonAt = null;
  } else if (prev.scoreKey !== model.scoreKey) {
    // The score moved: a game won opens the full board, any other point closes it.
    gameWonAt = model.gamesPlayed > prev.gamesPlayed ? now : null;
  } else {
    gameWonAt = prev.gameWonAt;
  }
  const memory: BoardMemory = { matchId: model.matchId, scoreKey: model.scoreKey, gamesPlayed: model.gamesPlayed, gameWonAt };
  const timer = model.clock !== null;
  const afterGame = gameWonAt !== null && now - gameWonAt < GAME_HOLD_MS;
  return { mode: timer || afterGame ? "full" : "compact", memory };
}

/* ---------------- the momentum line ---------------- */

export interface MomentumGeometry {
  /** The line, as an SVG path. */
  line: string;
  /** The line closed down to the midline, for the glow fill. */
  area: string;
  /** The latest point. */
  last: [number, number];
  /** The midline's y. */
  mid: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The momentum line of the last MOMENTUM_POINTS points: it climbs a step for each
 * point side A wins and drops a step for each one side B wins, from the midline.
 * Above the midline A has had the better of the run, below it B. Steps shrink
 * when the swing would leave the box.
 */
export function momentumGeometry(winners: TeamKey[], width = 520, height = 90, step = 7): MomentumGeometry {
  const mid = height / 2;
  const pad = 6;
  const clamp = (v: number) => Math.max(pad, Math.min(height - pad, v));
  const recent = winners.slice(-MOMENTUM_POINTS);
  const run: number[] = [];
  let y = 0;
  for (const w of recent) {
    y += w === "A" ? 1 : -1;
    run.push(y);
  }
  // A long run in one direction is scaled down to fit rather than flattened at the edge.
  const peak = Math.max(1, ...run.map(Math.abs));
  const k = Math.min(step, (mid - pad) / peak);
  const pts: [number, number][] = [[0, mid], ...run.map((v, n): [number, number] => [r1(((n + 1) / MOMENTUM_POINTS) * width), r1(clamp(mid - v * k))])];
  const line = pts.map(([x, v], n) => `${n ? "L" : "M"}${x} ${v}`).join(" ");
  const last = pts[pts.length - 1];
  return { line, area: `${line} L${last[0]} ${mid} L0 ${mid} Z`, last, mid };
}

/* ---------------- the stat boxes ---------------- */

/** One side's numbers, as the overlay's stats route sends them. */
export interface OverlaySideStats {
  aces?: number;
  doubleFaults: number;
  breaks: number;
  pointsWon: number;
}

export interface OverlayStats {
  /** The organiser shows aces ("Show aces on TV & app"). */
  aces: boolean;
  A: OverlaySideStats;
  B: OverlaySideStats;
}

export interface StatBox {
  label: string;
  a: number;
  b: number;
}

/** Aces (or double faults when aces are not shown), breaks, points won. */
export function statBoxes(s: OverlayStats | null): StatBox[] {
  if (!s) return [];
  const first: StatBox = s.aces
    ? { label: "Aces", a: s.A.aces ?? 0, b: s.B.aces ?? 0 }
    : { label: "Double faults", a: s.A.doubleFaults, b: s.B.doubleFaults };
  return [first, { label: "Breaks", a: s.A.breaks, b: s.B.breaks }, { label: "Points won", a: s.A.pointsWon, b: s.B.pointsWon }];
}
