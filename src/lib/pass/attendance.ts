/**
 * Match attendance on the event pass: when a check-in is open, and what it is worth.
 * Pure (no database, no clock of its own), so the rule is tested on its own and the
 * mini-game built on it later reads the same numbers.
 */

/** Check-in opens this long before the match's time (warm-up, players walking on). */
export const OPENS_BEFORE_MS = 20 * 60_000;
/** ...and stays open this long after the last point, for the fan who scans on the way out. */
export const CLOSES_AFTER_MS = 30 * 60_000;

export type CheckInWindow = { state: "open" } | { state: "too_early"; opensAt: string | null } | { state: "closed" };

const PLAYING = new Set(["live", "paused", "pending_sync"]);
const PLAYED = new Set(["completed", "retired", "disqualified"]);

/**
 * Open while the match is being played, from OPENS_BEFORE_MS before its time (or
 * once it is called to court, "ready"), and until CLOSES_AFTER_MS after it ended.
 * A match that was never played (walkover, cancelled) has nothing to attend.
 */
export function checkInWindow(m: { status: string; scheduledAt: string | null; endedAt: string | null }, nowMs: number): CheckInWindow {
  if (PLAYING.has(m.status) || m.status === "ready") return { state: "open" };
  if (PLAYED.has(m.status)) {
    const ended = m.endedAt ? Date.parse(m.endedAt) : NaN;
    return Number.isFinite(ended) && nowMs - ended <= CLOSES_AFTER_MS ? { state: "open" } : { state: "closed" };
  }
  if (m.status !== "scheduled") return { state: "closed" };
  const at = m.scheduledAt ? Date.parse(m.scheduledAt) : NaN;
  if (!Number.isFinite(at)) return { state: "too_early", opensAt: null };
  const opens = at - OPENS_BEFORE_MS;
  return nowMs >= opens ? { state: "open" } : { state: "too_early", opensAt: new Date(opens).toISOString() };
}

/**
 * A final: the tie played for first and second place, or a round named "Final"
 * (not a semi- or quarter-final).
 */
export function isFinal(m: { placesFrom?: number | null; placesTo?: number | null; roundName?: string | null }): boolean {
  if (m.placesFrom === 1 && m.placesTo === 2) return true;
  const name = (m.roundName ?? "").toLowerCase();
  return /\bfinal\b/.test(name) && !/semi|quarter|1\/4|1\/2/.test(name);
}

/**
 * The deciding rubber of a tie: every other rubber is decided and they are level,
 * so this one decides the tie (the doubles at 1-1 in a best of three). Judged when
 * the fan checks in; a rubber played alongside an unfinished one does not count yet.
 */
export function isDecidingRubber(matchId: string, rubbers: { id: string; winner: "A" | "B" | null }[]): boolean {
  const others = rubbers.filter((r) => r.id !== matchId);
  if (others.length < 2 || others.length === rubbers.length) return false;
  if (others.some((r) => r.winner === null)) return false;
  const a = others.filter((r) => r.winner === "A").length;
  return a * 2 === others.length;
}

export const ATTENDANCE_POINTS = { match: 10, final: 10, deciding: 5 } as const;

export interface PointsPart {
  label: string;
  points: number;
}

/** 10 for being there, +10 at a final, +5 at a deciding rubber. */
export function attendancePoints(m: { final: boolean; deciding: boolean }): { points: number; parts: PointsPart[] } {
  const parts: PointsPart[] = [{ label: "Match attended", points: ATTENDANCE_POINTS.match }];
  if (m.final) parts.push({ label: "Final", points: ATTENDANCE_POINTS.final });
  if (m.deciding) parts.push({ label: "Deciding rubber", points: ATTENDANCE_POINTS.deciding });
  return { points: parts.reduce((n, p) => n + p.points, 0), parts };
}
