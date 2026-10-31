/**
 * A chair umpire's list (migration 0034): today's matches on the court, across
 * every tournament of the code's event group (or its one tournament), and the
 * earlier days' matches with their scores ("Show earlier days"). Server-only.
 * Which matches and in which order: src/lib/orgs/courtScope.ts.
 */
import { db } from "../supabase";
import { courtDayList, courtEarlierDays, type CourtScope } from "../orgs/courtScope";
import { finalScoreSummary } from "../scoring/finalScore";
import type { ScoreState } from "../scoring/engine";
import type { Match } from "../types";

export interface CourtDay {
  live: Match[];
  upcoming: Match[];
  finished: Match[];
  earlier: { day: string; matches: Match[] }[];
  /** The score of each listed match that has one ("6-4 3-6 [10-7]"). */
  scores: Map<string, string>;
  tournaments: Map<string, { id: string; name: string; timezone: string }>;
}

/** Only the matches of `matches` a court scope lists today (live, upcoming, finished today). */
export function filterForCourt(scope: CourtScope, matches: Match[], timeZone: string, nowMs = Date.now()): Match[] {
  const on = matches.filter((m) => m.court_id && scope.courtIds.includes(m.court_id));
  const d = courtDayList(on, timeZone, nowMs);
  return [...d.live, ...d.upcoming, ...d.finished];
}

/** The court's matches of earlier days (newest day first). */
export function earlierForCourt(scope: CourtScope, matches: Match[], timeZone: string, nowMs = Date.now()) {
  return courtEarlierDays(matches.filter((m) => m.court_id && scope.courtIds.includes(m.court_id)), timeZone, nowMs);
}

/** Sets so far ("6-4 3-6"), from the matches' score snapshots. */
export async function scoresOf(matchIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < matchIds.length; i += 200) {
    const { data } = await db().from("match_score_snapshots").select("match_id, snapshot_json").in("match_id", matchIds.slice(i, i + 200));
    for (const r of (data ?? []) as { match_id: string; snapshot_json: ScoreState | null }[]) {
      const s = r.snapshot_json;
      if (!s?.completedSets?.length) continue;
      try {
        out.set(r.match_id, finalScoreSummary(s).sets);
      } catch {
        /* an older snapshot shape: no score shown */
      }
    }
  }
  return out;
}

/** Today's matches on the court, in every tournament the code covers, and its earlier days. */
export async function courtDay(scope: CourtScope, nowMs = Date.now()): Promise<CourtDay> {
  const tournaments = new Map<string, { id: string; name: string; timezone: string }>();
  if (!scope.courtIds.length || !scope.withCourt.length) return { live: [], upcoming: [], finished: [], earlier: [], scores: new Map(), tournaments };
  const [{ data: ts }, { data: ms }] = await Promise.all([
    db().from("tournaments").select("id, name, timezone, status").in("id", scope.withCourt),
    db().from("matches").select("*").in("court_id", scope.courtIds).in("tournament_id", scope.withCourt).neq("status", "cancelled").limit(1000),
  ]);
  for (const t of (ts ?? []) as { id: string; name: string; timezone: string | null; status: string }[]) {
    if (t.status === "archived") continue;
    tournaments.set(t.id, { id: t.id, name: t.name, timezone: t.timezone || "Africa/Cairo" });
  }
  const matches = ((ms ?? []) as Match[]).filter((m) => tournaments.has(m.tournament_id));
  // One venue, one day: the zone of the first tournament (they share the venue's).
  const tz = tournaments.values().next().value?.timezone ?? "Africa/Cairo";
  const d = courtDayList(matches, tz, nowMs);
  const earlier = courtEarlierDays(matches, tz, nowMs);
  const scores = await scoresOf([...d.live, ...d.finished, ...earlier.flatMap((e) => e.matches)].map((m) => m.id));
  return { ...d, earlier, scores, tournaments };
}
