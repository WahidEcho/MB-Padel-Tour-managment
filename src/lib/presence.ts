/**
 * "N watching" — who is on a public page right now.
 *
 * Pure helpers, kept framework-free and tested. The count is a cosmetic
 * courtesy: it tells a player the event is live and being watched. Nothing in
 * the system reads it, so it is allowed to be approximate, and it is capped for
 * display rather than reported precisely.
 */

/** Which public page a beat came from. Server-derived from a short enum. */
export type PresencePage = "overview" | "leaderboard" | "live" | "bracket" | "winner" | "session";

const PAGES: PresencePage[] = ["overview", "leaderboard", "live", "bracket", "winner", "session"];

export function isPresencePage(value: unknown): value is PresencePage {
  return typeof value === "string" && (PAGES as string[]).includes(value);
}

/** How often a browser reports that it is still there. */
export const BEAT_SECONDS = 20;

/**
 * How long a visitor counts after their last beat.
 *
 * Three times the beat interval, so a single dropped request — a phone that
 * slept for a moment, a flaky venue connection — does not make someone blink out
 * of the count and back in. The cost is that a visitor who closes the tab
 * lingers for up to a minute, which is the right way round: a number that
 * undercounts looks broken, one that is a few seconds stale does not.
 */
export const LIVE_WINDOW_SECONDS = 60;

/** Rows are swept once they are well past counting. */
export const SWEEP_AFTER_SECONDS = 300;

/**
 * The key a page's visitors are counted under.
 *
 * Always built here from ids the server resolved itself, never from anything the
 * client sent, so a caller cannot invent keys or write into another
 * tournament's count.
 */
export function presenceKey(tournamentId: string, page: PresencePage): string {
  return `t:${tournamentId}:${page}`;
}

/** Upper bound on a stored key, mirrored by a CHECK on the column. */
export const MAX_KEY_LENGTH = 120;

/**
 * Whether a visitor id is the shape this app issues.
 *
 * A client picks its own id, so this is not identity and proves nothing about
 * who is behind it. It is a tidiness bound: it keeps the column short and
 * predictable, and it means a scripted caller has to work at inflating the
 * count rather than posting a different long string every second.
 */
export function isVisitorId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/** How the count reads next to the page title. Never a precise figure. */
export function watchingLabel(count: number): string | null {
  if (count <= 1) return null; // Telling someone they are the only one watching helps nobody.
  if (count > 999) return "999+ watching";
  return `${count} watching`;
}
