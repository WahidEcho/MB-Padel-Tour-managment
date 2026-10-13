/**
 * The queue of matches waiting for a court: which match is next on it and
 * whether the court is busy. Courts belong to one event, so callers pass the
 * event's matches only (the plan: "next on court" looks inside the event).
 *
 * Used by the TV court slots (src/lib/tv/courtSlots.ts), the match-day engine
 * (calling a match to court) and the app's live courts hero.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import type { Match } from "../types";

/** The only fields the queue reads, so lean feed rows qualify. */
export type QueueMatch = Pick<Match, "id" | "court_id" | "status" | "scheduled_time" | "match_order">;

const WAITING = new Set(["scheduled", "ready"]);
const ON_COURT = new Set(["live", "paused"]);

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * The court's waiting matches in the order they go on: by scheduled time
 * (unscheduled last), then match order. `courtId` null takes `matches` as
 * already filtered to one court.
 */
export function courtQueue<M extends QueueMatch>(matches: M[], courtId: string | null = null): M[] {
  return matches
    .filter((m) => (courtId === null || m.court_id === courtId) && WAITING.has(m.status))
    .sort(
      (a, b) =>
        (time(a.scheduled_time) || Infinity) - (time(b.scheduled_time) || Infinity) || a.match_order - b.match_order,
    );
}

/** The court's next match, or null when nothing is waiting for it. */
export function nextOnCourt<M extends QueueMatch>(matches: M[], courtId: string | null = null): M | null {
  return courtQueue(matches, courtId)[0] ?? null;
}

/** A court is busy while a match on it is live or paused. */
export function courtBusy(matches: QueueMatch[], courtId: string): boolean {
  return matches.some((m) => m.court_id === courtId && ON_COURT.has(m.status));
}
