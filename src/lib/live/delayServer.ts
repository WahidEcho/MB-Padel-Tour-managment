/**
 * The audience delay on the server (pure rules in ./delay.ts). Every audience read
 * passes its matches, snapshots and ties through audienceView; with the delay off
 * (0, the default) they come back untouched and no query is made.
 *
 * With it on, only the matches whose snapshot changed inside the window need work:
 * their score events recorded after the cutoff are read in one query (number and
 * type only), then the one event before the window per match (its stored state) in
 * a second, and the UNDO watermark before the window in a third only when an UNDO
 * fell inside it. Everything else is the pure as-of rules.
 *
 * The delayed view is the same for everyone at a given moment, so the shared CDN
 * routes stay cacheable; the per-user `me/` routes stay private, no-store.
 */
import { db } from "../supabase";
import { memo } from "../mobile/http";
import type { Match, MatchSnapshot, MatchStatus, Standing, Tie, Tournament } from "../types";
import {
  cutoffFor,
  firstInWindow,
  lastUndoBefore,
  maskAdvancement,
  maskTieAdvancement,
  matchAsOf,
  scoreDelaySeconds,
  snapshotAsOf,
  snapshotNeedsRebuild,
  tiesAsOf,
  type AsOfEvent,
} from "./delay";

/** What an audience view needs of a match row (the public projections select at least this). */
export interface AudienceMatch {
  id: string;
  tournament_id: string;
  team_a_id: string | null;
  team_b_id: string | null;
  status: MatchStatus;
  winner_team_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  stage?: string;
  tie_id?: string | null;
  serving_team_id?: string | null;
  team_a_player_ids?: string[] | null;
  team_b_player_ids?: string[] | null;
}

type AudienceTie = Pick<Tie, "id" | "team_a_id" | "team_b_id" | "status" | "rubbers_a" | "rubbers_b" | "winner_team_id" | "ended_at"> & Partial<Pick<Tie, "stage" | "winner_to_tie_id" | "winner_to_side" | "loser_to_tie_id" | "loser_to_side">>;

/** A tournament's delay, read once per few seconds per server (the delay meter is not a hot write). */
export function scoreDelayFor(tournamentId: string): Promise<number> {
  return memo(`score-delay:${tournamentId}`, 5_000, async () => {
    const { data } = await db().from("tournaments").select("branding_config").eq("id", tournamentId).maybeSingle();
    return scoreDelaySeconds((data as { branding_config?: { scoreDelay?: unknown } | null } | null)?.branding_config);
  });
}

/** The delays of several tournaments (only those with one on are in the map). */
export async function scoreDelaysFor(tournamentIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(tournamentIds)];
  const out = new Map<string, number>();
  const seconds = await Promise.all(ids.map((id) => scoreDelayFor(id)));
  ids.forEach((id, i) => {
    if (seconds[i] > 0) out.set(id, seconds[i]);
  });
  return out;
}

/**
 * Snapshots as they stood at the cutoff (by match id; null = no score yet). Only
 * snapshots updated after the cutoff are looked at; the rest come back as they are.
 */
export async function snapshotsAsOf<S extends MatchSnapshot>(
  matches: Pick<AudienceMatch, "id" | "tournament_id" | "team_a_id" | "team_b_id">[],
  snapshots: S[],
  cutoffMs: number,
): Promise<Map<string, MatchSnapshot | null>> {
  const out = new Map<string, MatchSnapshot | null>(snapshots.map((s) => [s.match_id, s]));
  const byId = new Map(matches.map((m) => [m.id, m]));
  const recent = snapshots.filter((s) => byId.has(s.match_id) && snapshotNeedsRebuild(s, cutoffMs));
  if (!recent.length) return out;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const ids = recent.map((s) => s.match_id);
  // The window: everything recorded after the cutoff (a couple of minutes of play at most).
  const { data: windowRows } = await db()
    .from("score_events")
    .select("match_id, event_number, event_type")
    .in("match_id", ids)
    .gt("created_at_server", cutoffIso)
    .limit(5000);
  const inWindow = (windowRows ?? []) as { match_id: string; event_number: number; event_type: string }[];
  const first = firstInWindow(inWindow);
  if (!first.size) return out;
  const wanted = [...first.entries()].filter(([, n]) => n > 1);
  const [asOfRes, undoRes] = await Promise.all([
    wanted.length
      ? db()
          .from("score_events")
          .select("match_id, event_number, event_type, team_id, new_state_json, created_at_server")
          .or(wanted.map(([id, n]) => `and(match_id.eq.${id},event_number.eq.${n - 1})`).join(","))
      : Promise.resolve({ data: [] }),
    (() => {
      // The UNDO watermark before the window, only where an UNDO fell inside it.
      const need = recent.filter((s) => (first.get(s.match_id) ?? Infinity) <= (s.last_undo_event_number ?? 0)).map((s) => s.match_id);
      return need.length
        ? db().from("score_events").select("match_id, event_number").in("match_id", need).eq("event_type", "UNDO").lte("created_at_server", cutoffIso).limit(5000)
        : Promise.resolve({ data: [] });
    })(),
  ]);
  const asOf = new Map(((asOfRes.data ?? []) as AsOfEvent[]).map((e) => [e.match_id, e]));
  const undos = (undoRes.data ?? []) as { match_id: string; event_number: number }[];
  for (const s of recent) {
    const n = first.get(s.match_id);
    if (n === undefined) continue;
    const undo = (s.last_undo_event_number ?? 0) < n ? (s.last_undo_event_number ?? 0) : lastUndoBefore(undos, s.match_id, n);
    out.set(s.match_id, snapshotAsOf(byId.get(s.match_id)!, s, n, asOf.get(s.match_id) ?? null, undo));
  }
  return out;
}

export interface AudienceView<M extends AudienceMatch, S extends MatchSnapshot, T extends AudienceTie> {
  /** 0 when the delay is off (everything below is the input itself). */
  delaySeconds: number;
  /** The moment shown, in ms; null when the delay is off. */
  cutoffMs: number | null;
  matches: M[];
  snapshots: S[];
  ties: T[];
  /** Per match, the teams a result inside the window placed there (hidden; for bracket slots). */
  hidden: Map<string, Set<string>>;
  /** Whether anything differs from the stored rows. */
  changed: boolean;
}

/**
 * Matches, their snapshots and ties as the audience sees them now. `ties` with
 * their rubbers among `matches` (a tie's rubbers must all be there for its
 * score). `playDead`: whether a decided tie still plays its last rubber.
 */
export async function audienceView<M extends AudienceMatch, S extends MatchSnapshot, T extends AudienceTie = AudienceTie>(input: {
  delaySeconds: number;
  matches: M[];
  snapshots: S[];
  ties?: T[];
  playDead?: (tie: T) => boolean;
  now?: number;
}): Promise<AudienceView<M, S, T>> {
  const ties = input.ties ?? [];
  if (!(input.delaySeconds > 0)) {
    return { delaySeconds: 0, cutoffMs: null, matches: input.matches, snapshots: input.snapshots, ties, hidden: new Map(), changed: false };
  }
  const cutoffMs = cutoffFor(input.now ?? Date.now(), input.delaySeconds);
  let matches = input.matches.map((m) => matchAsOf(m, cutoffMs));
  // A match the audience does not see started has no score yet.
  const unstarted = new Set(matches.filter((m, i) => m.status === "scheduled" && input.matches[i].status !== "scheduled").map((m) => m.id));
  const rebuilt = await snapshotsAsOf(
    input.matches,
    input.snapshots.filter((s) => !unstarted.has(s.match_id)),
    cutoffMs,
  );
  const snapshots = input.snapshots.flatMap((s) => {
    if (unstarted.has(s.match_id)) return [];
    const r = rebuilt.has(s.match_id) ? rebuilt.get(s.match_id) : s;
    return r ? [r as S] : [];
  });
  let outTies = ties;
  if (ties.length) {
    const asOf = tiesAsOf(ties, input.matches, matches, input.playDead ?? (() => true));
    const masked = maskTieAdvancement(ties, asOf.ties, asOf.rubbers);
    outTies = masked.ties;
    matches = masked.rubbers;
  }
  const adv = maskAdvancement(input.matches, matches);
  matches = adv.matches;
  const changed =
    matches.some((m, i) => m !== input.matches[i]) || snapshots.length !== input.snapshots.length || snapshots.some((s, i) => s !== input.snapshots[i]) || outTies.some((t, i) => t !== ties[i]);
  return { delaySeconds: input.delaySeconds, cutoffMs, matches, snapshots, ties: outTies, hidden: adv.hidden, changed };
}

/**
 * Matches (of any tournaments) and their snapshots as the audience sees them: each
 * tournament's own delay. The players' and followers' own views (My matches, the
 * widget) where matches of several events meet.
 */
export async function audienceMatches<M extends AudienceMatch, S extends MatchSnapshot>(matches: M[], snapshots: S[], now = Date.now()): Promise<{ matches: M[]; snapshots: S[] }> {
  const delays = await scoreDelaysFor(matches.map((m) => m.tournament_id));
  if (!delays.size) return { matches, snapshots };
  const outMatches = new Map<string, M>();
  const outSnaps: S[] = [];
  const snapOf = new Map(snapshots.map((s) => [s.match_id, s]));
  const byTournament = new Map<string, M[]>();
  for (const m of matches) byTournament.set(m.tournament_id, [...(byTournament.get(m.tournament_id) ?? []), m]);
  for (const [tid, list] of byTournament) {
    const own = list.flatMap((m) => (snapOf.has(m.id) ? [snapOf.get(m.id)!] : []));
    const v = await audienceView({ delaySeconds: delays.get(tid) ?? 0, matches: list, snapshots: own, now });
    for (const m of v.matches) outMatches.set(m.id, m);
    outSnaps.push(...v.snapshots);
  }
  return { matches: matches.map((m) => outMatches.get(m.id) ?? m), snapshots: outSnaps };
}

/** The `created_at_server` bound for an audience read of score events, or null when the delay is off. */
export async function eventCutoffIso(tournamentId: string, now = Date.now()): Promise<string | null> {
  const s = await scoreDelayFor(tournamentId);
  return s > 0 ? new Date(cutoffFor(now, s)).toISOString() : null;
}

/** One match and its snapshot as the audience sees them (live activities, the match screen). */
export async function audienceMatch<M extends AudienceMatch>(match: M, snapshot: MatchSnapshot | null, now = Date.now()): Promise<{ match: M; snapshot: MatchSnapshot | null }> {
  const delay = await scoreDelayFor(match.tournament_id);
  if (!delay) return { match, snapshot };
  const v = await audienceView({ delaySeconds: delay, matches: [match], snapshots: snapshot ? [snapshot] : [], now });
  return { match: v.matches[0], snapshot: v.snapshots[0] ?? null };
}

/**
 * A whole tournament's matches, snapshots and ties as its audience sees them (the
 * public website's pages, which load all three anyway). Ties' rubbers are among
 * `matches`; snapshots may be left out (a bracket or podium needs none).
 */
export function tournamentAudience<M extends AudienceMatch, S extends MatchSnapshot, T extends AudienceTie = Tie>(
  t: Pick<Tournament, "branding_config" | "format_config">,
  data: { matches: M[]; snapshots?: S[]; ties?: T[] },
  now = Date.now(),
): Promise<AudienceView<M, S, T>> {
  return audienceView<M, S, T>({
    delaySeconds: scoreDelaySeconds(t.branding_config),
    matches: data.matches,
    snapshots: data.snapshots ?? [],
    ties: data.ties,
    playDead: (x) => x.stage === "group" || t.format_config?.ties?.playDeadRubbersInPlacement !== false,
    now,
  });
}

/* ---------------- standings and placings ---------------- */

type TableTournament = Pick<Tournament, "id" | "branding_config" | "format_config">;

/**
 * Whether a result the audience has not seen yet changed the tournament's tables
 * (a group match or tie finished inside the window): one small query, only with
 * the delay on.
 */
async function resultInWindow(t: TableTournament, cutoffMs: number): Promise<{ groups: boolean; placements: boolean }> {
  const cutoffIso = new Date(cutoffMs).toISOString();
  if (t.format_config?.ties) {
    const { data } = await db().from("ties").select("stage").eq("tournament_id", t.id).gt("ended_at", cutoffIso).limit(50);
    const rows = (data ?? []) as { stage: string }[];
    // A rubber finished inside the window changes the group table (rubbers, sets, games) too.
    const { data: rubbers } = await db().from("matches").select("id").eq("tournament_id", t.id).eq("stage", "group").gt("ended_at", cutoffIso).limit(1);
    return { groups: rows.some((r) => r.stage === "group") || (rubbers ?? []).length > 0, placements: rows.some((r) => r.stage === "placement") };
  }
  const { data } = await db().from("matches").select("id").eq("tournament_id", t.id).eq("stage", "group").gt("ended_at", cutoffIso).limit(1);
  return { groups: (data ?? []).length > 0, placements: false };
}

/**
 * The group tables and (tie events) the final places as the audience sees them:
 * the stored ones, unless a result inside the window changed them; then they are
 * computed again from the as-of matches, without being written.
 */
export async function audienceTables(t: TableTournament, stored: Standing[], now = Date.now()): Promise<{ standings: Standing[]; ties: Tie[] | null }> {
  const delay = scoreDelaySeconds(t.branding_config);
  if (!delay) return { standings: stored, ties: null };
  const cutoffMs = cutoffFor(now, delay);
  const hit = await resultInWindow(t, cutoffMs);
  if (!hit.groups && !hit.placements) return { standings: stored, ties: null };
  const { getMatches, getSnapshots, getTournament } = await import("../data");
  const [matches, snapshots] = await Promise.all([getMatches(t.id), getSnapshots(t.id)]);
  if (t.format_config?.ties) {
    const { getTies, tieStandingsRows } = await import("../tennis/tieOps");
    const ties = await getTies(t.id);
    const playDead = (x: Tie) => x.stage === "group" || t.format_config?.ties?.playDeadRubbersInPlacement !== false;
    const v = await audienceView({ delaySeconds: delay, matches, snapshots, ties, playDead, now });
    const standings = hit.groups ? ((await tieStandingsRows(t.id, { ties: v.ties, rubbers: v.matches as Match[], snapshots: v.snapshots })) as Standing[]) : stored;
    return { standings, ties: v.ties };
  }
  const full = await getTournament(t.id);
  if (!full) return { standings: stored, ties: null };
  const v = await audienceView({ delaySeconds: delay, matches, snapshots, now });
  const { standingsRows } = await import("../ops");
  return { standings: await standingsRows(full, { matches: v.matches, snapshots: v.snapshots }), ties: null };
}
