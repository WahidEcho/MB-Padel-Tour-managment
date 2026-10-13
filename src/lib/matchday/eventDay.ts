/**
 * Which calendar day it is at the event, and whether today is a match day.
 * Pure (no Node or Next APIs): the venue codes, the pass stamps and the match-day
 * engine all count days the same way.
 */

/** The event's calendar day for an instant (YYYY-MM-DD in the event's zone). */
export function eventDay(timeZone: string, atMs = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(atMs));
  return parts;
}

/**
 * Whether a day (YYYY-MM-DD, the event's zone) is one of the event's days. Without
 * dates every day counts; with only a start, the event is that one day.
 */
export function isEventDay(day: string, startsOn: string | null, endsOn: string | null): boolean {
  if (!startsOn) return true;
  return day >= startsOn && day <= (endsOn ?? startsOn);
}

export interface MatchDayTournament {
  status: string;
  timezone?: string | null;
  starts_on?: string | null;
  ends_on?: string | null;
}

/**
 * A match day: the tournament is running and today is one of its days in its own
 * zone. A tournament without dates has no days to go by, so it counts only while
 * a match is actually live.
 */
export function isMatchDay(t: MatchDayTournament, nowMs = Date.now(), hasLiveMatch = false): boolean {
  if (t.status !== "active") return false;
  if (!t.starts_on) return hasLiveMatch;
  let day: string;
  try {
    day = eventDay(t.timezone || "Africa/Cairo", nowMs);
  } catch {
    day = eventDay("Africa/Cairo", nowMs);
  }
  return isEventDay(day, t.starts_on, t.ends_on ?? null);
}
