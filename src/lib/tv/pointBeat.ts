/**
 * What just happened on a court, from two observations of its score.
 *
 * The venue screen does not see individual points. It sees a score every couple
 * of seconds, and between two looks any number of things may have happened: one
 * point, a game, a referee undoing a mis-tap and scoring the right side, or — if
 * the tab was hidden — half a set. This decides which of those it was, and
 * refuses to animate anything it cannot be sure of. A beat that runs backwards,
 * or celebrates the wrong side, reads to a crowd as a scoring error; no beat at
 * all reads as nothing.
 *
 * Pure and framework-free.
 */

export type Side = "A" | "B";

/** One observation of a court's score. */
export interface ScoreFrame {
  /** Monotonic, server-written. Every event bumps it — including an UNDO. */
  eventNumber: number;
  /**
   * The event number of the most recent UNDO applied to the match, 0 if none.
   *
   * Needed because events are append-only: an UNDO is a NEW event with a HIGHER
   * number than the point it cancels, so `eventNumber` alone only ever goes up
   * and can never reveal that anything was taken back.
   */
  undoWatermark: number;
  sets: [number, number];
  games: [number, number];
  tiebreak: boolean;
  tiebreakPoints: [number, number];
  /** Padel point labels: "0", "15", "30", "40", "AD". */
  points: [string, string];
  matchOver: boolean;
}

export type Beat =
  | { kind: "none"; reason: BeatSilence }
  | { kind: "point" | "game" | "set"; side: Side };

export type BeatSilence =
  | "first-look"
  | "unchanged"
  | "stale"
  | "too-much-changed"
  | "undo"
  | "match-over";

/** How long since this card last looked, for spotting a gap it cannot bridge. */
export interface BeatContext {
  observedGapMs: number;
  /** A tab hidden longer than this has missed too much to narrate. */
  maxGapMs?: number;
}

const POINT_RANK: Record<string, number> = { "0": 0, "15": 1, "30": 2, "40": 3, AD: 4 };

function rank(label: string): number {
  return POINT_RANK[label] ?? 0;
}

function decreased(prev: [number, number], next: [number, number]): boolean {
  return next[0] < prev[0] || next[1] < prev[1];
}

/** Which single side gained, if exactly one did. */
function gainer(prev: [number, number], next: [number, number]): Side | null {
  const a = next[0] - prev[0];
  const b = next[1] - prev[1];
  if (a > 0 && b <= 0) return "A";
  if (b > 0 && a <= 0) return "B";
  return null;
}

/**
 * Decides the beat, most conservative rule first.
 *
 * Games are checked before points on purpose: a won game takes the point labels
 * from 40 back to 0, which read on its own looks like a lost point.
 */
export function classifyPointChange(prev: ScoreFrame | null, next: ScoreFrame, ctx: BeatContext): Beat {
  // A finished match belongs to the result animation. The final point would
  // otherwise play a set beat one poll before the result starts on the same card.
  if (next.matchOver) return { kind: "none", reason: "match-over" };

  if (!prev) return { kind: "none", reason: "first-look" };
  if (next.eventNumber === prev.eventNumber) return { kind: "none", reason: "unchanged" };

  // A hidden tab coming back has missed an unknown amount of play.
  if (ctx.observedGapMs > (ctx.maxGapMs ?? 20_000)) return { kind: "none", reason: "stale" };

  // Anything taken back snaps silently.
  if (next.undoWatermark > prev.undoWatermark) return { kind: "none", reason: "undo" };
  if (decreased(prev.sets, next.sets)) return { kind: "none", reason: "undo" };

  // Sets before games: winning a set resets both sides' games to 0, so a games
  // decrease on its own is expected here and must not be read as an undo.
  const setsGained = next.sets[0] + next.sets[1] - (prev.sets[0] + prev.sets[1]);
  if (setsGained > 1) return { kind: "none", reason: "too-much-changed" };
  if (setsGained === 1) {
    const side = gainer(prev.sets, next.sets);
    return side ? { kind: "set", side } : { kind: "none", reason: "too-much-changed" };
  }

  // Within a set, games only ever go up; one going down is a correction.
  if (decreased(prev.games, next.games)) return { kind: "none", reason: "undo" };

  const gamesGained = next.games[0] + next.games[1] - (prev.games[0] + prev.games[1]);
  // Two games cannot both be won inside a couple of seconds; if the frames say
  // they were, too much happened between looks to say which beat was which.
  if (gamesGained > 1) return { kind: "none", reason: "too-much-changed" };
  if (gamesGained === 1) {
    const side = gainer(prev.games, next.games);
    return side ? { kind: "game", side } : { kind: "none", reason: "too-much-changed" };
  }

  if (next.tiebreak && prev.tiebreak) {
    if (decreased(prev.tiebreakPoints, next.tiebreakPoints)) return { kind: "none", reason: "undo" };
    const side = gainer(prev.tiebreakPoints, next.tiebreakPoints);
    return side ? { kind: "point", side } : { kind: "none", reason: "unchanged" };
  }

  // A plain point. Labels are an enum, so compare by rank. Losing an advantage
  // is the one case where the scorer's own label does not move: at AD-40, the
  // trailing side wins the point and it is the leader who drops back to 40.
  const a = rank(next.points[0]) - rank(prev.points[0]);
  const b = rank(next.points[1]) - rank(prev.points[1]);
  if (a > 0 && b <= 0) return { kind: "point", side: "A" };
  if (b > 0 && a <= 0) return { kind: "point", side: "B" };
  if (a < 0 && b === 0) return { kind: "point", side: "B" };
  if (b < 0 && a === 0) return { kind: "point", side: "A" };
  return { kind: "none", reason: "unchanged" };
}
