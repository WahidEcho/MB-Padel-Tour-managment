/**
 * Queries behind the app's public read routes. Each returns a contract shape
 * (contract.ts) built through projection.ts, so nothing private leaves here.
 *
 * Only tournaments that are public, of kind "tournament", and not demos (unless
 * asked for, or placed in an event group) are visible. Every function selects only the columns it needs: at
 * event load these run a few times a second, and egress is the free tier's limit.
 */
import { db } from "../supabase";
import type { BrandingConfig, Match, MatchSnapshot, ScoringConfig, Standing, Team, Tie } from "../types";
import { activeLiveVideos, withLiveVideo } from "../stream/liveVideo";
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
  scoreExtrasOf,
  toStandingRow,
  toTie,
  type OrgBranding,
  type TimelineRow,
  type TournamentRow,
} from "./projection";
import { memo } from "./http";
import { appleWalletConfigured, googleWalletConfigured } from "../pass/wallet";
import { authProviders } from "../auth/users";
import { APP_PAGE_URL } from "../site";
import { DISCOVER_ORDER_KEY, inDiscoverOrder, parseDiscoverOrder } from "../platform/discoverOrder";

export const CARD_COLUMNS =
  "id, slug, name, sport, kind, status, is_demo, public_access_enabled, branding_config, format_config, lower_third_text, updated_at, event_group_id, venue_name, city, timezone, starts_on, ends_on, app_skin, organization_id";

/**
 * Approved organisations' link and branding, by id, for tournament cards (the
 * organisation's page and the skin defaults). Public fields only. A tournament of
 * an organisation that is not approved shows no organisation.
 */
export function publicOrgBranding(): Promise<Map<string, OrgBranding>> {
  return memo("orgs:branding", 30_000, async () => {
    const { data } = await db().from("organizations").select("id, slug, name, status, colors, logo_url").eq("status", "approved").limit(2000);
    return new Map(((data ?? []) as (OrgBranding & { status: string })[]).map((o) => [o.id, { id: o.id, slug: o.slug, name: o.name, colors: o.colors, logo_url: o.logo_url }]));
  });
}

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
    const [live, teams, groupsRes, orderRes, orgs] = await Promise.all([
      liveCounts(ids),
      teamCounts(ids),
      db().from("event_groups").select("*").order("featured_rank", { ascending: true }),
      db().from("platform_settings").select("value_json").eq("key", DISCOVER_ORDER_KEY).maybeSingle(),
      publicOrgBranding(),
    ]);
    // Admin → Discover sets this order; featured_rank (kept in step by the same page) is the fallback.
    const order = parseDiscoverOrder((orderRes.data as { value_json: unknown } | null)?.value_json);
    const cards = rows.map((r) => toCard(r, live.get(r.id) ?? 0, teams.get(r.id) ?? 0, orgs.get(r.organization_id ?? "") ?? null));
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
    const featured = inDiscoverOrder(
      groups.filter((g, i) => g.tournaments.length > 0 && ((groupsRes.data as GroupRow[])[i]?.featured_rank ?? null) !== null),
      (g) => [g.id],
      order,
    );
    const inFeatured = new Set(featured.flatMap((g) => g.tournaments.map((t) => t.id)));
    const today = new Date().toISOString().slice(0, 10);
    const rest = cards.filter((c) => !inFeatured.has(c.id));
    const isPast = (c: MTournamentCard) => c.status === "completed" || (c.endsOn !== null && c.endsOn < today);
    const isUpcoming = (c: MTournamentCard) => !isPast(c) && c.liveCount === 0 && c.startsOn !== null && c.startsOn > today;
    return {
      generatedAt: new Date().toISOString(),
      featured,
      live: inDiscoverOrder(rest.filter((c) => c.liveCount > 0), (c) => [c.id, c.eventGroupId], order),
      upcoming: rest.filter((c) => c.liveCount === 0 && isUpcoming(c)),
      past: rest.filter((c) => c.liveCount === 0 && !isUpcoming(c)),
    };
  });
}

/**
 * Reads for one account (GET /me/t/<slug>/…, src/app/api/mobile/v1/me/t): the
 * route has already decided the account may read the tournament
 * (tournamentVisibleTo), so a league session that is not public is let through.
 * Kept in this instance's memo apart from the public reads.
 */
export interface ReadScope {
  restricted?: boolean;
}

/**
 * A public tournament by slug. A friendly session's hidden tournament is shown
 * only when the session is a night or the season of a public league (Phase 7,
 * visibility 'everyone'): every other session stays out of the shared app reads,
 * as before. With `restricted` (the per-user reads), a night or season of a league
 * that is not public is let through too: the caller checked who is asking.
 */
async function tournamentBySlug(slug: string, withMatchDay = false, scope: ReadScope = {}): Promise<TournamentRow | null> {
  const query = (columns: string) =>
    db().from("tournaments").select(columns).eq("slug", slug).in("kind", ["tournament", "friendly_session"]).eq("public_access_enabled", true).maybeSingle();
  // match_day_rules arrives with migration 0022. Until it is applied, the bundle
  // still loads and reads as "match day off" rather than the app losing the event.
  let row: TournamentRow | null;
  if (!withMatchDay) row = ((await query(CARD_COLUMNS)).data as unknown as TournamentRow | null) ?? null;
  else {
    // The bundle also carries the per-stage scoring rules.
    let { data, error } = await query(`${CARD_COLUMNS}, scoring_config, match_day_rules`);
    if (error && /match_day_rules/.test(error.message)) ({ data, error } = await query(`${CARD_COLUMNS}, scoring_config`));
    row = (data as unknown as TournamentRow | null) ?? null;
  }
  if (row && row.kind === "friendly_session") {
    const { isPublicLeagueSession, leagueSessionShown } = await import("../leagues/server");
    if (!(await (scope.restricted ? leagueSessionShown(row.id) : isPublicLeagueSession(row.id)))) return null;
  }
  return row;
}

const scopeKey = (scope: ReadScope) => (scope.restricted ? "r:" : "");

export function getBundle(slug: string, scope: ReadScope = {}): Promise<MBundle | null> {
  return memo(`bundle:${scopeKey(scope)}${slug}`, 10_000, async () => {
    const t = await tournamentBySlug(slug, true, scope);
    if (!t) return null;
    const [teams, courts, groups, groupTeams, live, plate, orgs] = await Promise.all([
      getTeams(t.id),
      db().from("courts").select("id, court_name, court_order, is_active").eq("tournament_id", t.id).order("court_order"),
      db().from("groups").select("id, group_name, group_order").eq("tournament_id", t.id).order("group_order"),
      db().from("group_teams").select("team_id, group_id").eq("tournament_id", t.id),
      liveCounts([t.id]),
      plateBrackets([t.id]),
      publicOrgBranding(),
    ]);
    const groupOf = new Map(((groupTeams.data ?? []) as { team_id: string; group_id: string }[]).map((g) => [g.team_id, g.group_id]));
    const courtRows = (courts.data ?? []) as { id: string; court_name: string; court_order: number; is_active: boolean }[];
    const bundle = toBundle(
      t,
      teams as Team[],
      groupOf,
      courtRows,
      (groups.data ?? []) as { id: string; group_name: string; group_order: number }[],
      live.get(t.id) ?? 0,
      plate.get(t.id) ?? [],
      orgs.get(t.organization_id ?? "") ?? null,
    );
    // Live video (Live stream tab): only on the courts streamed now. Additive: 1.0.1 ignores it.
    const videos = activeLiveVideos(t.branding_config, courtRows.map((c) => ({ id: c.id, name: c.court_name, is_active: c.is_active })));
    if (videos.size) bundle.courts = bundle.courts.map((c) => (videos.has(c.id) ? { ...c, liveVideo: videos.get(c.id)! } : c));
    return bundle;
  });
}

/** The Plate brackets of each tournament (the stage rules tell a Plate match by its bracket). */
export async function plateBrackets(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const { data } = await db().from("brackets").select("id, tournament_id").in("tournament_id", ids).eq("tier", "plate");
  for (const r of (data ?? []) as { id: string; tournament_id: string }[]) out.set(r.tournament_id, [...(out.get(r.tournament_id) ?? []), r.id]);
  return out;
}

export const MATCH_COLUMNS =
  "id, tournament_id, stage, bracket_id, group_id, round_name, match_order, court_id, scheduled_time, team_a_id, team_b_id, status, serving_team_id, winner_team_id, started_at, ended_at, tie_id, rubber_no, rubber_type, team_a_player_ids, team_b_player_ids";
export const SNAPSHOT_COLUMNS =
  "match_id, current_set_number, team_a_point_label, team_b_point_label, team_a_games, team_b_games, team_a_sets, team_b_sets, is_tiebreak, tiebreak_team_a_points, tiebreak_team_b_points, serving_team_id, last_event_number, last_undo_event_number, completed_sets, snapshot_json, updated_at";

export function getLive(slug: string, scope: ReadScope = {}): Promise<MLive | null> {
  return memo(`live:${scopeKey(scope)}${slug}`, 1_500, async () => {
    // With the match-day rules: scoring v2's aces and timers are shown only when the organiser says so.
    const t = await tournamentBySlug(slug, true, scope);
    if (!t) return null;
    const [matches, snaps, ties, ann, bundle, courtRows] = await Promise.all([
      db().from("matches").select(MATCH_COLUMNS).eq("tournament_id", t.id).order("match_order"),
      db().from("match_score_snapshots").select(SNAPSHOT_COLUMNS).eq("tournament_id", t.id),
      t.format_config?.ties ? db().from("ties").select("*").eq("tournament_id", t.id).order("tie_order") : Promise.resolve({ data: [] }),
      latestAnnouncements(t.id, t.event_group_id ?? null),
      getBundle(slug, scope),
      db().from("courts").select("id, court_name, is_active").eq("tournament_id", t.id),
    ]);
    const snapOf = new Map(((snaps.data ?? []) as unknown as MatchSnapshot[]).map((s) => [s.match_id, s]));
    const videos = activeLiveVideos(
      t.branding_config,
      ((courtRows.data ?? []) as { id: string; court_name: string; is_active: boolean }[]).map((c) => ({ id: c.id, name: c.court_name, is_active: c.is_active })),
    );
    return {
      generatedAt: new Date().toISOString(),
      tournamentId: t.id,
      bundleVersion: bundle?.version ?? "",
      ties: ((ties.data ?? []) as Tie[]).map(toTie),
      matches: ((matches.data ?? []) as unknown as Match[])
        .filter((m) => m.status !== "cancelled" || m.tie_id)
        .map((m) => withLiveVideo(toMatch(m, snapOf.get(m.id) ?? null, scoreExtrasOf(t)), videos)),
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

export function getStandings(slug: string, scope: ReadScope = {}): Promise<MStandings | null> {
  return memo(`standings:${scopeKey(scope)}${slug}`, 5_000, async () => {
    const t = await tournamentBySlug(slug, false, scope);
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
      .select("slug, kind, sport, public_access_enabled, scoring_config, match_day_rules, branding_config")
      .eq("id", m.tournament_id)
      .maybeSingle();
    const tr = t as { slug: string; kind: string; sport: string; public_access_enabled: boolean; scoring_config: ScoringConfig | null; match_day_rules: unknown; branding_config: BrandingConfig | null } | null;
    if (!tr || !tr.public_access_enabled || tr.kind !== "tournament") return null;
    const [{ data: snap }, { data: court }] = await Promise.all([
      db().from("match_score_snapshots").select(SNAPSHOT_COLUMNS).eq("match_id", matchId).maybeSingle(),
      m.court_id ? db().from("courts").select("id, court_name, is_active").eq("id", m.court_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const snapshot = snap as unknown as MatchSnapshot | null;
    const c = court as { id: string; court_name: string; is_active: boolean } | null;
    const videos = activeLiveVideos(tr.branding_config, c ? [{ id: c.id, name: c.court_name, is_active: c.is_active }] : []);
    return { match: withLiveVideo(toMatch(m, snapshot, scoreExtrasOf(tr)), videos), tournamentSlug: tr.slug, situation: await situationOf(m, snapshot, tr) };
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
  // The live courts hero on Discover (each tournament's Match day tab can still switch it off).
  live_courts: true,
};

/** The stored flags over the defaults. */
export function flagsFrom(stored: Record<string, unknown> | null | undefined): Record<string, boolean> {
  const flags = { ...DEFAULT_FLAGS };
  for (const [k, v] of Object.entries(stored ?? {})) if (typeof v === "boolean") flags[k] = v;
  return flags;
}

/** Just the flags, for server code that acts on one (the courts hero). */
export function getFlags(): Promise<Record<string, boolean>> {
  return memo("flags", 15_000, async () => {
    const { data } = await db().from("platform_settings").select("value_json").eq("key", "flags").maybeSingle();
    return flagsFrom((data as { value_json: Record<string, unknown> } | null)?.value_json);
  });
}

export function getConfig(): Promise<MConfig> {
  return memo("config", 15_000, async () => {
    const { data } = await db().from("platform_settings").select("key, value_json").in("key", ["flags", "app"]);
    const byKey = new Map(((data ?? []) as { key: string; value_json: Record<string, unknown> }[]).map((r) => [r.key, r.value_json]));
    const flags = flagsFrom(byKey.get("flags"));
    const app = byKey.get("app") ?? {};
    const signIn = await authProviders();
    return {
      apiVersion: API_VERSION,
      minAppVersion: typeof app.minAppVersion === "string" ? app.minAppVersion : "1.0.0",
      flags,
      walletReady: { apple: appleWalletConfigured(), google: googleWalletConfigured() },
      supportUrl: typeof app.supportUrl === "string" ? app.supportUrl : `${APP_PAGE_URL}/support`,
      privacyUrl: typeof app.privacyUrl === "string" ? app.privacyUrl : `${APP_PAGE_URL}/privacy`,
      signIn,
    };
  });
}
