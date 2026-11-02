/**
 * The public reads (event pages, court TVs and their feed), shared for a moment.
 *
 * Every viewer of a public page or a court TV used to run the same queries on its
 * own, every one or two seconds. On match day (2 Nov 2026) that was ~90 requests a
 * second against a small database, which filled its connection pool and took the
 * site down. These wrappers keep each result in the server instance for a short
 * window and share one in-flight query between requests that arrive together, so
 * a hundred viewers of one event cost about one query per window.
 *
 * Only for what everyone sees alike. Admin, referee consoles and the scoring write
 * path keep reading the database directly (src/lib/data.ts): an organiser's edit or
 * a referee's point must never read an older copy.
 *
 * Windows: scores (matches, snapshots, ties) 1 s; the event, teams, courts and
 * screens a few seconds; the venue and event-info switches longer. Each caller gets
 * its own copy (structuredClone), so code that sorts or edits a result in place
 * cannot change what the next request reads.
 */
import { memo } from "./mobile/http";
import {
  getBrackets,
  getBracketSlots,
  getCourts,
  getGroups,
  getMatch,
  getMatches,
  getScreenSettings,
  getSnapshot,
  getSnapshots,
  getStandings,
  getTeams,
  getTournamentBySlug,
} from "./data";
import { getTies } from "./tennis/tieOps";
import { watchTargets } from "./watch";
import { hasPublicVenue } from "./venue/server";
import { hasPublicEventInfo } from "./eventInfo/server";

export const SCORE_MS = 1_000;
export const EVENT_MS = 3_000;
export const SLOW_MS = 10_000;

function shared<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  return memo(`pub:${key}`, ttlMs, fn).then((v) => (v === null || v === undefined ? v : structuredClone(v)));
}

export const publicTournamentBySlug = (slug: string) => shared(`t:${slug}`, EVENT_MS, () => getTournamentBySlug(slug));
export const publicTeamRows = (tournamentId: string) => shared(`teams:${tournamentId}`, EVENT_MS, () => getTeams(tournamentId));
export const publicCourts = (tournamentId: string) => shared(`courts:${tournamentId}`, SLOW_MS, () => getCourts(tournamentId));
export const publicGroups = (tournamentId: string) => shared(`groups:${tournamentId}`, SLOW_MS, () => getGroups(tournamentId));
export const publicStandings = (tournamentId: string) => shared(`standings:${tournamentId}`, EVENT_MS, () => getStandings(tournamentId));
export const publicBrackets = (tournamentId: string) => shared(`brackets:${tournamentId}`, EVENT_MS, () => getBrackets(tournamentId));
export const publicBracketSlots = (bracketId: string) => shared(`slots:${bracketId}`, EVENT_MS, () => getBracketSlots(bracketId));
export const publicMatches = (tournamentId: string) => shared(`matches:${tournamentId}`, SCORE_MS, () => getMatches(tournamentId));
export const publicMatch = (matchId: string) => shared(`match:${matchId}`, SCORE_MS, () => getMatch(matchId));
export const publicSnapshots = (tournamentId: string) => shared(`snaps:${tournamentId}`, SCORE_MS, () => getSnapshots(tournamentId));
export const publicSnapshot = (matchId: string) => shared(`snap:${matchId}`, SCORE_MS, () => getSnapshot(matchId));
export const publicTies = (tournamentId: string) => shared(`ties:${tournamentId}`, SCORE_MS, () => getTies(tournamentId));
export const publicScreenSettings = (tournamentId: string, screenKey: string) =>
  shared(`screen:${tournamentId}:${screenKey}`, EVENT_MS, () => getScreenSettings(tournamentId, screenKey));
export const publicWatchTargets = (tournamentId: string) => shared(`watch:${tournamentId}`, EVENT_MS, () => watchTargets(tournamentId));
export const publicHasVenue = (slug: string) => shared(`venue:${slug}`, SLOW_MS, () => hasPublicVenue(slug));
export const publicHasEventInfo = (slug: string) => shared(`info:${slug}`, SLOW_MS, () => hasPublicEventInfo(slug));
