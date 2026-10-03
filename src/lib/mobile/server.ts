/**
 * Queries behind the app's public read routes. Each returns a contract shape
 * (contract.ts) built through projection.ts, so nothing private leaves here.
 *
 * Only tournaments that are public, of kind "tournament", and not demos (unless
 * asked for, or placed in an event group) are visible. Every function selects only the columns it needs: at
 * event load these run a few times a second, and egress is the free tier's limit.
 */
import { db } from "../supabase";
import type { Match, MatchSnapshot, ScoringConfig, Standing, Team, Tie } from "../types";
import type { ScoreState } from "../scoring/engine";
import { getTeams } from "../data";
import type {
  MAnnouncement,
  MBundle,
  MConfig,
  MDiscover,
  MEventGroup,
  MLive,
  MMatchDetail,
  MSituation,
  MStandings,
  MTimeline,
  MTournamentCard,
} from "./contract";
import { API_VERSION } from "./contract";
import {
  buildTimeline,
  toBundle,
  toCard,
  toMatch,
  toStandingRow,
  toTie,
  type TimelineRow,
  type TournamentRow,
} from "./projection";
import { memo } from "./http";
import { appleWalletConfigured, googleWalletConfigured } from "../pass/wallet";
import { authProviders } from "../auth/users";

const CARD_COLUMNS =
  "id, slug, name, sport, kind, status, is_demo, public_access_enabled, branding_config, format_config, lower_third_text, updated_at, event_group_id, venue_name, city, timezone, starts_on, ends_on, app_skin";

interface GroupRow {
  id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  venue_name: string | null;
  city: string | null;
  timezone: string;
  starts_on: string | null;
  ends_on: string | null;
  artwork_url: string | null;
  featured_rank: number | null;
}

async function visibleTournaments(includeDemo: boolean): Promise<TournamentRow[]> {
  let q = db()
    .from("tournaments")
    .select(CARD_COLUMNS)
    .eq("kind", "tournament")
    .eq("public_access_enabled", true)
    .in("status", ["active", "completed"]);
  // A demo shows once an admin puts it in an event group (a demo event set up on purpose).
  if (!includeDemo) q = q.or("is_demo.eq.false,event_group_id.not.is.null");
  const { data } = await q.order("created_at", { ascending: false }).limit(60);
  return (data ?? []) as unknown as TournamentRow[];
}

async function liveCounts(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const { data } = await db().from("matches").select("tournament_id").in("tournament_id", ids).in("status", ["live", "paused"]);
  for (const r of (data ?? []) as { tournament_id: string }[]) out.set(r.tournament_id, (out.get(r.tournament_id) ?? 0) + 1);
  return out;
}

async function teamCounts(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const { data } = await db().from("teams").select("tournament_id").in("tournament_id", ids);
  for (const r of (data ?? []) as { tournament_id: string }[]) out.set(r.tournament_id, (out.get(r.tournament_id) ?? 0) + 1);
  return out;
}

export function getDiscover(includeDemo: boolean): Promise<MDiscover> {
  return memo(`discover:${includeDemo}`, 5_000, async () => {
    const rows = await visibleTournaments(includeDemo);
    const ids = rows.map((r) => r.id);
    const [live, teams, groupsRes] = await Promise.all([
      liveCounts(ids),
      teamCounts(ids),
      db().from("event_groups").select("*").order("featured_rank", { ascending: true }),
    ]);
    const cards = rows.map((r) => toCard(r, live.get(r.id) ?? 0, teams.get(r.id) ?? 0));
    const groups = ((groupsRes.data ?? []) as GroupRow[]).map((g): MEventGroup => {
      const members = cards.filter((c) => c.eventGroupId === g.id);
      return {
        id: g.id,
        slug: g.slug,
        name: g.name,
        subtitle: g.subtitle,
        venue: g.venue_name,
        city: g.city,
        startsOn: g.starts_on,
        endsOn: g.ends_on,
        timezone: g.timezone,
        artworkUrl: g.artwork_url,
        liveCount: members.reduce((n, c) => n + c.liveCount, 0),
        tournaments: members,
      };
    });
    const featured = groups.filter((g, i) => g.tournaments.length > 0 && ((groupsRes.data as GroupRow[])[i]?.featured_rank ?? null) !== null);
    const inFeatured = new Set(featured.flatMap((g) => g.tournaments.map((t) => t.id)));
    const today = new Date().toISOString().slice(0, 10);
    const rest = cards.filter((c) => !inFeatured.has(c.id));
    const isPast = (c: MTournamentCard) => c.status === "completed" || (c.endsOn !== null && c.endsOn < today);
    const isUpcoming = (c: MTournamentCard) => !isPast(c) && c.liveCount === 0 && c.startsOn !== null && c.startsOn > today;
    return {
      generatedAt: new Date().toISOString(),
      featured,
      live: rest.filter((c) => c.liveCount > 0),
      upcoming: rest.filter((c) => c.liveCount === 0 && isUpcoming(c)),
      past: rest.filter((c) => c.liveCount === 0 && !isUpcoming(c)),
    };
  });
}

async function tournamentBySlug(slug: string): Promise<TournamentRow | null> {
  const { data } = await db()
    .from("tournaments")
    .select(CARD_COLUMNS)
    .eq("slug", slug)
    .eq("kind", "tournament")
    .eq("public_access_enabled", true)
    .maybeSingle();
  return (data as unknown as TournamentRow | null) ?? null;
}

export function getBundle(slug: string): Promise<MBundle | null> {
  return memo(`bundle:${slug}`, 10_000, async () => {
    const t = await tournamentBySlug(slug);
    if (!t) return null;
    const [teams, courts, groups, groupTeams, live] = await Promise.all([
      getTeams(t.id),
      db().from("courts").select("id, court_name, court_order, is_active").eq("tournament_id", t.id).order("court_order"),
      db().from("groups").select("id, group_name, group_order").eq("tournament_id", t.id).order("group_order"),
      db().from("group_teams").select("team_id, group_id").eq("tournament_id", t.id),
      liveCounts([t.id]),
    ]);
    const groupOf = new Map(((groupTeams.data ?? []) as { team_id: string; group_id: string }[]).map((g) => [g.team_id, g.group_id]));
    return toBundle(
      t,
      teams as Team[],
      groupOf,
      (courts.data ?? []) as { id: string; court_name: string; court_order: number; is_active: boolean }[],
      (groups.data ?? []) as { id: string; group_name: string; group_order: number }[],
      live.get(t.id) ?? 0,
    );
  });
}

const MATCH_COLUMNS =
  "id, tournament_id, stage, bracket_id, group_id, round_name, match_order, court_id, scheduled_time, team_a_id, team_b_id, status, serving_team_id, winner_team_id, started_at, ended_at, tie_id, rubber_no, rubber_type, team_a_player_ids, team_b_player_ids";
const SNAPSHOT_COLUMNS =
  "match_id, current_set_number, team_a_point_label, team_b_point_label, team_a_games, team_b_games, team_a_sets, team_b_sets, is_tiebreak, tiebreak_team_a_points, tiebreak_team_b_points, serving_team_id, last_event_number, last_undo_event_number, completed_sets, snapshot_json, updated_at";

export function getLive(slug: string): Promise<MLive | null> {
  return memo(`live:${slug}`, 1_500, async () => {
    const t = await tournamentBySlug(slug);
    if (!t) return null;
    const [matches, snaps, ties, ann, bundle] = await Promise.all([
      db().from("matches").select(MATCH_COLUMNS).eq("tournament_id", t.id).order("match_order"),
      db().from("match_score_snapshots").select(SNAPSHOT_COLUMNS).eq("tournament_id", t.id),
      t.format_config?.ties ? db().from("ties").select("*").eq("tournament_id", t.id).order("tie_order") : Promise.resolve({ data: [] }),
      latestAnnouncements(t.id, t.event_group_id ?? null),
      getBundle(slug),
    ]);
    const snapOf = new Map(((snaps.data ?? []) as unknown as MatchSnapshot[]).map((s) => [s.match_id, s]));
    return {
      generatedAt: new Date().toISOString(),
      tournamentId: t.id,
      bundleVersion: bundle?.version ?? "",
      ties: ((ties.data ?? []) as Tie[]).map(toTie),
      matches: ((matches.data ?? []) as unknown as Match[])
        .filter((m) => m.status !== "cancelled" || m.tie_id)
        .map((m) => toMatch(m, snapOf.get(m.id) ?? null)),
      announcements: ann,
    };
  });
}

async function latestAnnouncements(tournamentId: string, groupId: string | null): Promise<MAnnouncement[]> {
  const filter = groupId ? `tournament_id.eq.${tournamentId},event_group_id.eq.${groupId}` : `tournament_id.eq.${tournamentId}`;
  const { data, error } = await db()
    .from("announcements")
    .select("id, title, body, level, published_at")
    .or(filter)
    .lte("published_at", new Date().toISOString())
    .order("published_at", { ascending: false })
    .limit(5);
  if (error) return [];
  return ((data ?? []) as { id: string; title: string; body: string | null; level: "major" | "info"; published_at: string }[]).map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    level: a.level,
    publishedAt: a.published_at,
  }));
}

export function getStandings(slug: string): Promise<MStandings | null> {
  return memo(`standings:${slug}`, 5_000, async () => {
    const t = await tournamentBySlug(slug);
    if (!t) return null;
    const [groups, rows] = await Promise.all([
      db().from("groups").select("id, group_name, group_order").eq("tournament_id", t.id).order("group_order"),
      db().from("standings_snapshots").select("*").eq("tournament_id", t.id).order("rank"),
    ]);
    const standings = (rows.data ?? []) as Standing[];
    let placings: { place: number; teamId: string }[] = [];
    if (t.format_config?.ties) {
      try {
        const { finalPlacings } = await import("../tennis/tieOps");
        placings = (await finalPlacings(t.id)).map((p) => ({ place: p.place, teamId: p.team_id }));
      } catch {
        placings = [];
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      groups: ((groups.data ?? []) as { id: string; group_name: string }[]).map((g) => ({
        id: g.id,
        name: g.group_name,
        rows: standings.filter((s) => s.group_id === g.id).map(toStandingRow),
      })),
      placings,
    };
  });
}

/** One match, only if its tournament is public. */
export function getMatchDetail(matchId: string): Promise<MMatchDetail | null> {
  return memo(`match:${matchId}`, 800, async () => {
    const { data } = await db().from("matches").select(MATCH_COLUMNS).eq("id", matchId).maybeSingle();
    const m = data as unknown as Match | null;
    if (!m) return null;
    const { data: t } = await db()
      .from("tournaments")
      .select("slug, kind, sport, public_access_enabled, scoring_config")
      .eq("id", m.tournament_id)
      .maybeSingle();
    const tr = t as { slug: string; kind: string; sport: string; public_access_enabled: boolean; scoring_config: ScoringConfig | null } | null;
    if (!tr || !tr.public_access_enabled || tr.kind !== "tournament") return null;
    const { data: snap } = await db().from("match_score_snapshots").select(SNAPSHOT_COLUMNS).eq("match_id", matchId).maybeSingle();
    const snapshot = snap as unknown as MatchSnapshot | null;
    return { match: toMatch(m, snapshot), tournamentSlug: tr.slug, situation: await situationOf(m, snapshot, tr) };
  });
}

/** Whether the next point is a break, set or match point, by the engine and this match's rules. */
async function situationOf(
  m: Match,
  snap: MatchSnapshot | null,
  t: { sport: string; scoring_config: ScoringConfig | null },
): Promise<MSituation> {
  const none: MSituation = { kind: null, side: null };
  const state = snap?.snapshot_json as ScoreState | null;
  if (!state || state.matchOver || !["live", "paused"].includes(m.status) || t.sport === "chess") return none;
  try {
    const [{ pointOutcome }, { scoringConfigForMatch }, { tierForMatch }] = await Promise.all([
      import("../scoring/engine"),
      import("../scoring/rules"),
      import("../data"),
    ]);
    const config = scoringConfigForMatch(t, m, await tierForMatch(m), {
      doubles: m.rubber_type ? m.rubber_type === "D" : (m.team_a_player_ids?.length ?? 0) > 1,
    });
    for (const side of ["A", "B"] as const) if (pointOutcome(state, side, config).winsMatch) return { kind: "match", side };
    for (const side of ["A", "B"] as const) if (pointOutcome(state, side, config).winsSet) return { kind: "set", side };
    const server = state.servingTeam;
    for (const side of ["A", "B"] as const) if (server && side !== server && pointOutcome(state, side, config).winsGame) return { kind: "break", side };
    return none;
  } catch {
    return none;
  }
}

export function getTimeline(matchId: string): Promise<MTimeline | null> {
  return memo(`timeline:${matchId}`, 4_000, async () => {
    const detail = await getMatchDetail(matchId);
    if (!detail) return null;
    // Only the three numbers per event the chart needs, never the stored states:
    // full states are ~2 KB per point and would dominate the database's egress.
    const { data } = await db()
      .from("score_events")
      .select("event_number, event_type, team_id, ga:new_state_json->teamA->games, gb:new_state_json->teamB->games, set:new_state_json->currentSet")
      .eq("match_id", matchId)
      .order("event_number");
    const rows = ((data ?? []) as Record<string, unknown>[]).map(
      (r): TimelineRow => ({
        event_number: Number(r.event_number),
        event_type: String(r.event_type),
        team_id: (r.team_id as string | null) ?? null,
        ga: r.ga == null ? null : Number(r.ga),
        gb: r.gb == null ? null : Number(r.gb),
        set: r.set == null ? null : Number(r.set),
      }),
    );
    return { matchId, points: buildTimeline(rows, detail.match.a) };
  });
}

export const DEFAULT_FLAGS: Record<string, boolean> = {
  player_claim: true,
  live_activity: false,
  takeovers: true,
  supporter_mode: false,
  pins: false,
  momentum: true,
  // Legacy: the generic "Add to Wallet" button of builds before the Apple Wallet badge.
  wallet: false,
  // The "Add to Apple Wallet" badge on the pass (iOS). Not in the stored flags yet, so this default applies.
  apple_wallet: true,
  recap: false,
  share_stories: true,
  accounts: true,
};

export function getConfig(): Promise<MConfig> {
  return memo("config", 15_000, async () => {
    const { data } = await db().from("platform_settings").select("key, value_json").in("key", ["flags", "app"]);
    const byKey = new Map(((data ?? []) as { key: string; value_json: Record<string, unknown> }[]).map((r) => [r.key, r.value_json]));
    const flags = { ...DEFAULT_FLAGS };
    for (const [k, v] of Object.entries(byKey.get("flags") ?? {})) if (typeof v === "boolean") flags[k] = v;
    const app = byKey.get("app") ?? {};
    const signIn = await authProviders();
    return {
      apiVersion: API_VERSION,
      minAppVersion: typeof app.minAppVersion === "string" ? app.minAppVersion : "1.0.0",
      flags,
      walletReady: { apple: appleWalletConfigured(), google: googleWalletConfigured() },
      supportUrl: typeof app.supportUrl === "string" ? app.supportUrl : "https://mb-tournament.vercel.app/movescore/support",
      privacyUrl: typeof app.privacyUrl === "string" ? app.privacyUrl : "https://mb-tournament.vercel.app/movescore/privacy",
      signIn,
    };
  });
}
