/**
 * Court referee codes (migration 0034): which matches a code limited to one
 * physical court reaches, and what its referee sees today. Pure (no Node, browser
 * or Next.js APIs): the server, the web console and the app share it.
 *
 * Courts are rows per tournament, so the physical court is its name ("Court 1")
 * inside the code's event group (every tournament of the group) or its one
 * tournament. Names are compared case- and space-insensitively (`courtKey`).
 *
 * The owner's defaults, each in one place here:
 * - COURT_LIST_DAY_ONLY: the referee's list is today's (the event's own day, Cairo),
 *   live first, then upcoming in order, then finished today.
 * - SHOW_UNTIMED: an upcoming match on the court with no time yet is listed too
 *   (last), so a match the desk forgot to time can still be scored.
 * - SHOW_OVERDUE: an unfinished match timed on an earlier day (rain, a late
 *   change nobody re-timed) is listed with today's upcoming matches.
 * Reaching a match (scoring it) depends on the court only, never on the day: a
 * match that runs past midnight is still the court's.
 */
import { eventDay } from "../matchday/eventDay";

export const COURT_LIST_DAY_ONLY = true;
/** A carry-over token (after switching courts) lasts at most this long. */
export const CARRY_HOURS = 12;
/** A match the server has finished stays reachable by a carry-over this long after it ended (unsent last points, an undo). */
export const CARRY_GRACE_MINUTES = 30;
export const SHOW_UNTIMED = true;
export const SHOW_OVERDUE = true;

/** What a court code reaches, resolved from the database on every request. */
export interface CourtScope {
  /** The court's name as the organiser saw it when the code was made ("Court 1"). */
  name: string;
  /** courtKey(name). */
  key: string;
  /** The event group the code covers, or null for a one-tournament code. */
  eventGroupId: string | null;
  /** The tournaments (kind "tournament") the code covers, in the code's organisation. */
  tournamentIds: string[];
  /** Every court row named like the court, in those tournaments. */
  courtIds: string[];
  /** The tournaments among them that have the court (the referee's list of events). */
  withCourt: string[];
}

/** "Court 1" → "Court 1 referee": a court code's label (the referee's list, the audit). */
export function courtCodeLabel(court: string): string {
  return `${court.trim()} referee`.slice(0, 80);
}

/** "  court   1 " → "court 1": the physical court's comparable name. */
export function courtKey(name: string | null | undefined): string {
  return String(name ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The court rows of the tournaments that carry the court's name. */
export function courtIdsNamed(courts: { id: string; tournament_id: string; court_name: string }[], tournamentIds: string[], name: string): string[] {
  const key = courtKey(name);
  const inScope = new Set(tournamentIds);
  return courts.filter((c) => inScope.has(c.tournament_id) && courtKey(c.court_name) === key).map((c) => c.id);
}

/** Whether a court scope reaches a match (its current court; moved away = not reached). */
export function courtReachesMatch(scope: Pick<CourtScope, "tournamentIds" | "courtIds">, match: { tournamentId: string | null; courtId: string | null | undefined }): boolean {
  if (!match.tournamentId || !scope.tournamentIds.includes(match.tournamentId)) return false;
  return Boolean(match.courtId) && scope.courtIds.includes(match.courtId!);
}

/**
 * The physical courts of a set of tournaments, by name, in court order: one entry
 * per name however many tournaments have it ("Court 1" of both events = one court).
 */
export function physicalCourts(courts: { id: string; tournament_id: string; court_name: string; court_order?: number | null }[]): { name: string; key: string; courtIds: string[]; tournamentIds: string[] }[] {
  const byKey = new Map<string, { name: string; key: string; courtIds: string[]; tournamentIds: string[]; order: number }>();
  for (const c of courts) {
    const key = courtKey(c.court_name);
    if (!key) continue;
    const e = byKey.get(key) ?? { name: c.court_name.trim().replace(/\s+/g, " "), key, courtIds: [], tournamentIds: [], order: Number.MAX_SAFE_INTEGER };
    e.courtIds.push(c.id);
    if (!e.tournamentIds.includes(c.tournament_id)) e.tournamentIds.push(c.tournament_id);
    e.order = Math.min(e.order, c.court_order ?? Number.MAX_SAFE_INTEGER);
    byKey.set(key, e);
  }
  // "Court 2" before "Court 10": numbers inside names compare as numbers.
  return [...byKey.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }) || a.order - b.order)
    .map(({ order, ...rest }) => (void order, rest));
}

export type CourtListSection = "live" | "upcoming" | "finished";

export interface CourtListMatch {
  id: string;
  status: string;
  scheduled_time: string | null;
  ended_at?: string | null;
  updated_at?: string | null;
  match_order?: number | null;
  court_id: string | null;
}

const LIVE = new Set(["live", "paused", "pending_sync"]);
export const FINISHED_STATUSES: ReadonlySet<string> = new Set(["completed", "walkover", "disqualified", "retired"]);
const FINISHED = FINISHED_STATUSES;

/**
 * Whether a carry-over credential still reaches a match it lists: while the match is
 * not finished (or cancelled), and for CARRY_GRACE_MINUTES after it ended.
 */
export function carryStillReaches(match: { status?: string | null; endedAt?: string | null }, nowMs = Date.now()): boolean {
  const status = match.status ?? "";
  if (status === "cancelled") return false;
  if (!FINISHED_STATUSES.has(status)) return true;
  const ended = match.endedAt ? Date.parse(match.endedAt) : NaN;
  return Number.isFinite(ended) && nowMs - ended <= CARRY_GRACE_MINUTES * 60_000;
}

function dayOf(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    return eventDay(timeZone, ms);
  } catch {
    return eventDay("Africa/Cairo", ms);
  }
}

/** Where a match on the court goes in its referee's list today, or null when it is not listed. */
export function courtListSection(m: CourtListMatch, timeZone: string, nowMs = Date.now()): CourtListSection | null {
  if (m.status === "cancelled") return null;
  if (LIVE.has(m.status)) return "live";
  let today: string;
  try {
    today = eventDay(timeZone, nowMs);
  } catch {
    today = eventDay("Africa/Cairo", nowMs);
  }
  if (FINISHED.has(m.status)) {
    if (!COURT_LIST_DAY_ONLY) return "finished";
    return dayOf(m.ended_at ?? m.updated_at ?? m.scheduled_time, timeZone) === today ? "finished" : null;
  }
  // scheduled / ready (called to court)
  if (m.status === "ready") return "upcoming";
  if (!COURT_LIST_DAY_ONLY) return "upcoming";
  const day = dayOf(m.scheduled_time, timeZone);
  if (!day) return SHOW_UNTIMED ? "upcoming" : null;
  if (day === today) return "upcoming";
  if (day < today) return SHOW_OVERDUE ? "upcoming" : null;
  return null;
}

/**
 * Today's list for a court: live first, then upcoming by time (untimed last, then
 * by match order), then finished today, most recent first.
 */
export function courtDayList<M extends CourtListMatch>(matches: M[], timeZone: string, nowMs = Date.now()): { live: M[]; upcoming: M[]; finished: M[] } {
  const out = { live: [] as M[], upcoming: [] as M[], finished: [] as M[] };
  for (const m of matches) {
    const s = courtListSection(m, timeZone, nowMs);
    if (s) out[s].push(m);
  }
  const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY);
  const byTime = (a: M, b: M) => t(a.scheduled_time) - t(b.scheduled_time) || (a.match_order ?? 0) - (b.match_order ?? 0);
  out.live.sort(byTime);
  out.upcoming.sort(byTime);
  out.finished.sort((a, b) => t(b.ended_at ?? b.updated_at) - t(a.ended_at ?? a.updated_at));
  return out;
}

/**
 * "Show earlier days" (owner's decision): the court's matches of days before today,
 * hidden by default under today's list. Newest day first, each day in time order.
 * A match already in today's list (live, upcoming, overdue) is not repeated.
 */
export function courtEarlierDays<M extends CourtListMatch>(matches: M[], timeZone: string, nowMs = Date.now()): { day: string; matches: M[] }[] {
  let today: string;
  try {
    today = eventDay(timeZone, nowMs);
  } catch {
    today = eventDay("Africa/Cairo", nowMs);
  }
  const byDay = new Map<string, M[]>();
  for (const m of matches) {
    if (m.status === "cancelled" || courtListSection(m, timeZone, nowMs) !== null) continue;
    const day = dayOf(FINISHED.has(m.status) ? (m.ended_at ?? m.updated_at ?? m.scheduled_time) : m.scheduled_time, timeZone);
    if (!day || day >= today) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), m]);
  }
  const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY);
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, ms]) => ({ day, matches: ms.sort((a, b) => t(a.scheduled_time) - t(b.scheduled_time) || (a.match_order ?? 0) - (b.match_order ?? 0)) }));
}

/* ---------------- the court QR ---------------- */

/**
 * The link printed on a court's QR sheet: `https://tour.mbeg.org/r#K7QM-W3XT-9HRP`.
 * The code rides in the #fragment, which a browser never sends to the server, so
 * it is in no server, CDN or proxy log; the /r page posts it in a request body.
 */
export function courtLink(site: string, formattedCode: string): string {
  return `${site.replace(/\/+$/, "")}/r#${encodeURIComponent(formattedCode)}`;
}

/** The code inside a court link (or a bare code), as typed; null for anything else. */
export function parseCourtLink(data: string): string | null {
  const s = String(data ?? "").trim();
  if (!s || s.length > 300) return null;
  const m = /^(?:https?:\/\/[^/#?]+|movescore:\/\/)?\/?r\/?#([A-Za-z0-9-]{12,20})$/.exec(s);
  if (!m) return null;
  return decodeURIComponent(m[1]);
}
