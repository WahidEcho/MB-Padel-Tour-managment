/**
 * Timelines for the venue screen, seeked from a server timestamp.
 *
 * The one rule every animation on the wall follows: its stage is a function of
 * how long ago something happened, never of when a component mounted. A screen
 * that re-renders on a poll, reloads after a dropped connection, or is opened
 * half-way through an entrance must land on the same frame as every other screen
 * — so an entrance cannot replay on refresh, not because anything guards against
 * it but because there is nothing to replay.
 *
 * Pure and framework-free; the React hook is a thin wrapper.
 */

/**
 * Client time corrected to the server's clock.
 *
 * A venue PC can be minutes out. Measured against its own clock, a result hold
 * would either park over live play or expire instantly, and both look like a
 * bug on the wall. Each poll carries the server's time, so the offset is
 * re-measured every couple of seconds.
 */
export interface ClockAnchor {
  /** Server epoch ms at the moment the payload was produced. */
  serverMs: number;
  /** Client epoch ms at the moment the payload arrived. */
  clientMs: number;
}

export function anchoredNow(anchor: ClockAnchor | null, clientNowMs: number): number {
  if (!anchor) return clientNowMs;
  return anchor.serverMs + (clientNowMs - anchor.clientMs);
}

/** Milliseconds since `startIso`, never negative. Null when there is no start. */
export function elapsedSince(startIso: string | null | undefined, nowMs: number): number | null {
  if (!startIso) return null;
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, nowMs - start);
}

export interface StageOptions {
  /**
   * Past this, the timeline is treated as already finished. A screen that joins
   * long after something started should show the settled frame, not the tail of
   * an intro nobody in the room saw begin.
   */
  skipAfterMs?: number;
}

/**
 * Which stage of a timeline is showing.
 *
 * `marks` are the offsets, in ms, at which each stage begins — [0, 500, 1300]
 * is three stages. Returns the index of the last mark reached, -1 before the
 * first, and `marks.length` once the timeline is over or skipped.
 */
export function stageForElapsed(marks: number[], elapsedMs: number | null, opts: StageOptions = {}): number {
  if (elapsedMs === null) return marks.length;
  if (opts.skipAfterMs !== undefined && elapsedMs >= opts.skipAfterMs) return marks.length;
  let stage = -1;
  for (let i = 0; i < marks.length; i++) {
    if (elapsedMs >= marks[i]) stage = i;
  }
  return stage;
}

/**
 * The CSS that starts a keyframe animation part-way through.
 *
 * A negative animation-delay tells the browser the animation began that long
 * ago, so it renders the correct frame immediately and runs to the end. This is
 * how a seeked timeline is expressed without an animation library: nothing is
 * scheduled in JavaScript, and a dropped frame costs nothing because the
 * compositor owns the motion.
 */
export function seekStyle(elapsedMs: number, beginsAtMs = 0): { animationDelay: string } {
  return { animationDelay: `${Math.round(beginsAtMs - elapsedMs)}ms` };
}

/* ------------------------------------------------------------------ */
/* The named timelines                                                 */
/* ------------------------------------------------------------------ */

/** A 9-second entrance. The extra time is in the hold, not the movement. */
export const ENTRANCE = {
  marks: [0, 500, 1300, 2600, 3400, 8200],
  names: ["strip", "teamA", "teamB", "ranks", "hold", "exit"] as const,
  durationMs: 9000,
  /** The 9 seconds plus one poll of slack. */
  skipAfterMs: 14_000,
};

/** A 5-second result, then a hold measured from the same instant. */
export const RESULT = {
  marks: [0, 300, 900, 2000, 2600],
  names: ["recede", "winner", "score", "players", "hold"] as const,
  durationMs: 5000,
  /** The finished card stays up this long after the result is confirmed. */
  holdMs: 15_000,
};

/** How long each scoring beat plays inside its own card. */
export const BEAT_MS = { point: 900, game: 1600, set: 2400 } as const;
