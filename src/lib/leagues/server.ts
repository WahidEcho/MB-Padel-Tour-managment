/**
 * Leagues on the server (Phase 7): who a signed-in account plays as, which
 * league a match counts in, recomputing a league's points, its boards and the
 * top boards, joining, and the app's public views.
 *
 * Points are a function of the results as they stand: every finalise, undo and
 * correction recomputes the whole league from its finished matches and writes
 * only the rows that change (unique per match + player), so a retry or a
 * correction can never count twice and an undo leaves nothing behind. The rows
 * are read before the results, so a concurrent recompute can only ever add the
 * rows of a match that finished in between, never delete them.
 *
 * Boards and league pages show names and numbers only, and the names an
 * organisation is allowed to show (src/lib/orgs/personFields.ts): never a
 * profile id, phone, email or photo.
 *
 * Server-only.
 */
import { paymentProvider } from "../payments/provider";
import { db } from "../supabase";
import { memo } from "../mobile/http";
import type {
  MBoardLine,
  MBoardPeriod,
  MJoinMode,
  MLeague,
  MLeagueCard,
  MLeagueFixture,
  MLeagueNight,
  MNightTable,
  MMyLeague,
  MMyLeagues,
  MOrgRef,
  MTopBoard,
} from "../mobile/contract";
import { isUuid, MOVE_BEYOND_SLUG } from "../orgs/roles";
import { ensureOrgPlayer } from "../orgs/scope";
import { orgDisplayNames, UNNAMED_MATCHED } from "../orgs/personFields";
import { leaguePoints, leaguePointsKey, leaguePointsRules, type LeaguePointsRow, type LeagueResult } from "./points";
import { boardMonths, rankBoard, topOfAllLeagues, type BoardEntry, type BoardLength, type BoardLine, BOARD_LENGTHS } from "./boards";
import { joinDecision, normalizeJoinModes, type JoinMode, type MembershipStatus } from "./join";
import { leagueResultsOfMatch, type LeagueSnapshotInput } from "./results";
import { addDays, BOARD_LABELS, isMonth, leagueFee, leaguePeriods, leagueTakesMembers, moneyLabel, PUBLIC_LEAGUE_STATUSES } from "./settings";
import { leagueInviteCodeMatches } from "./inviteCode";
import { eventDay } from "../matchday/eventDay";

/* ---------------- rows ---------------- */

/** Every league column but the invite-code hash. */
export const LEAGUE_COLUMNS =
  "id, organization_id, slug, name, about, sport, kind, status, join_modes, fee, points_rules, periods, counts_toward_top_of_all, match_day_rules, night_template, timezone, invite_code_set_at, created_at, updated_at";

export interface LeagueRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  about: string | null;
  sport: string;
  kind: "nights" | "season";
  status: "draft" | "active" | "closed" | "archived";
  join_modes: string[];
  fee: unknown;
  points_rules: unknown;
  periods: unknown;
  counts_toward_top_of_all: boolean;
  match_day_rules: unknown;
  night_template: unknown;
  timezone: string;
  invite_code_set_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DivisionRow {
  id: string;
  league_id: string;
  name: string;
  sort_order: number;
  season_session_id: string | null;
}

export interface MemberRow {
  id: string;
  league_id: string;
  division_id: string | null;
  player_profile_id: string;
  partner_profile_id: string | null;
  auth_user_id: string | null;
  status: MembershipStatus;
  pay_at_venue: boolean;
  paid_until: string | null;
  source: "app" | "admin";
  created_at: string;
}

export interface FixtureRow {
  id: string;
  league_id: string;
  division_id: string;
  kind: "night" | "match" | "tournament";
  session_id: string | null;
  tournament_id: string | null;
  match_id: string | null;
  home_member_id: string | null;
  away_member_id: string | null;
  round: number | null;
  date: string;
}

interface PointsRowDb {
  league_id: string;
  division_id: string | null;
  player_profile_id: string;
  match_id: string;
  kind: LeaguePointsRow["kind"];
  components: { base?: number; streak?: number } | null;
  points: number | string;
  month: string;
  streak_after: number;
  games_won: number;
  games_lost: number;
}

const FIXTURE_COLUMNS = "id, league_id, division_id, kind, session_id, tournament_id, match_id, home_member_id, away_member_id, round, date";
const MEMBER_COLUMNS = "id, league_id, division_id, player_profile_id, partner_profile_id, auth_user_id, status, pay_at_venue, paid_until, source, created_at";

async function chunked<T>(ids: string[], fetch: (part: string[]) => PromiseLike<{ data: unknown }>): Promise<T[]> {
  const out: T[] = [];
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 200) {
    const { data } = await fetch(unique.slice(i, i + 200));
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export async function getLeague(id: string): Promise<LeagueRow | null> {
  if (!isUuid(id)) return null;
  const { data } = await db().from("leagues").select(LEAGUE_COLUMNS).eq("id", id).maybeSingle();
  return (data as LeagueRow | null) ?? null;
}

export async function getDivisions(leagueId: string): Promise<DivisionRow[]> {
  const { data } = await db().from("league_divisions").select("id, league_id, name, sort_order, season_session_id").eq("league_id", leagueId).order("sort_order").order("name");
  return (data ?? []) as DivisionRow[];
}

export async function getMembers(leagueId: string): Promise<MemberRow[]> {
  const { data } = await db().from("league_members").select(MEMBER_COLUMNS).eq("league_id", leagueId).order("created_at").limit(5000);
  return (data ?? []) as MemberRow[];
}

export async function getFixtures(leagueId: string): Promise<FixtureRow[]> {
  const { data } = await db().from("league_fixtures").select(FIXTURE_COLUMNS).eq("league_id", leagueId).order("date").order("round").limit(10000);
  return (data ?? []) as FixtureRow[];
}

/* ---------------- who the app user plays as ---------------- */

export interface UserProfile {
  profileId: string;
  /** Always true: the profile is the account's own (player_profiles.auth_user_id). */
  confirmed: true;
  /** The profile's public name, for the name an organisation the player joins sees. */
  publicName: string;
}

/**
 * The player profile this app account plays as: the profile it speaks for
 * (player_profiles.auth_user_id, set by Phase 1's linking, src/lib/players/link.ts),
 * and nothing else. A claimed row whose profile the proof did not reach (rows
 * linked without their profile) does not make the account that player here, and
 * neither does an earlier league membership: an account that lost its profile
 * (unlinked, or the code it came through was reset) plays as nobody.
 */
export async function profileForUser(userId: string): Promise<UserProfile | null> {
  if (!isUuid(userId)) return null;
  const { data: own } = await db().from("player_profiles").select("id, public_name, merged_into_profile_id, approval_status").eq("auth_user_id", userId).limit(5);
  const linked = ((own ?? []) as { id: string; public_name: string; merged_into_profile_id: string | null; approval_status: string }[]).find(
    (p) => !p.merged_into_profile_id && p.approval_status !== "merged",
  );
  return linked ? { profileId: linked.id, confirmed: true, publicName: linked.public_name } : null;
}

/* ---------------- which league a match counts in ---------------- */

/** The leagues a match's results count in (normally one, or none). */
export async function leaguesOfMatch(match: { id: string; tournament_id: string }): Promise<string[]> {
  if (!isUuid(match.tournament_id)) return [];
  const out = new Set<string>();
  const { data: t } = await db().from("tournaments").select("kind, counts_toward").eq("id", match.tournament_id).maybeSingle();
  const tr = t as { kind: string; counts_toward: string | null } | null;
  if (!tr) return [];
  if (tr.counts_toward) {
    const { data: d } = await db().from("league_divisions").select("league_id").eq("id", tr.counts_toward).maybeSingle();
    if (d) out.add((d as { league_id: string }).league_id);
  }
  if (tr.kind === "friendly_session") {
    const { data: s } = await db().from("friendly_sessions").select("id").eq("tournament_id", match.tournament_id).maybeSingle();
    if (s) {
      const { data: f } = await db().from("league_fixtures").select("league_id").eq("session_id", (s as { id: string }).id).limit(1);
      for (const r of (f ?? []) as { league_id: string }[]) out.add(r.league_id);
      const { data: d } = await db().from("league_divisions").select("league_id").eq("season_session_id", (s as { id: string }).id).limit(1);
      for (const r of (d ?? []) as { league_id: string }[]) out.add(r.league_id);
    }
  }
  return [...out];
}

/** Hidden session tournaments that belong to a league (the app may show them). Cached briefly per instance. */
export function leagueSessionTournamentIds(): Promise<Set<string>> {
  return memo("leagues:session-tournaments", 3_000, async () => {
    const { data: f } = await db().from("league_fixtures").select("session_id").not("session_id", "is", null).limit(20000);
    const { data: d } = await db().from("league_divisions").select("season_session_id").not("season_session_id", "is", null).limit(5000);
    const sessionIds = [
      ...((f ?? []) as { session_id: string }[]).map((r) => r.session_id),
      ...((d ?? []) as { season_session_id: string }[]).map((r) => r.season_session_id),
    ];
    const rows = await chunked<{ tournament_id: string }>(sessionIds, (part) => db().from("friendly_sessions").select("tournament_id").in("id", part));
    return new Set(rows.map((r) => r.tournament_id));
  });
}

/** Whether a hidden session tournament belongs to a public league of an approved organisation. Uncached: for single lookups. */
export async function isPublicLeagueSession(tournamentId: string): Promise<boolean> {
  if (!isUuid(tournamentId)) return false;
  const { data: s } = await db().from("friendly_sessions").select("id").eq("tournament_id", tournamentId).maybeSingle();
  if (!s) return false;
  const sid = (s as { id: string }).id;
  const [{ data: f }, { data: d }] = await Promise.all([
    db().from("league_fixtures").select("league_id").eq("session_id", sid).limit(1),
    db().from("league_divisions").select("league_id").eq("season_session_id", sid).limit(1),
  ]);
  const leagueId = ((f ?? []) as { league_id: string }[])[0]?.league_id ?? ((d ?? []) as { league_id: string }[])[0]?.league_id;
  if (!leagueId) return false;
  const { data: l } = await db().from("leagues").select("status, organization_id").eq("id", leagueId).maybeSingle();
  const league = l as { status: string; organization_id: string } | null;
  if (!league || !(PUBLIC_LEAGUE_STATUSES as readonly string[]).includes(league.status)) return false;
  // Only an approved organisation's leagues are public (a suspended or pending one's are not).
  const { data: o } = await db().from("organizations").select("status").eq("id", league.organization_id).maybeSingle();
  return (o as { status: string } | null)?.status === "approved";
}

/* ---------------- recomputing a league's points ---------------- */

interface MatchRow {
  id: string;
  tournament_id: string;
  status: string | null;
  winner_team_id: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  ended_at: string | null;
  team_a_player_ids: string[] | null;
  team_b_player_ids: string[] | null;
}

const FINISHED = ["completed", "walkover", "disqualified", "retired"];
const MATCH_COLS = "id, tournament_id, status, winner_team_id, team_a_id, team_b_id, ended_at, team_a_player_ids, team_b_player_ids";

interface GatheredResult {
  result: LeagueResult;
  divisionId: string;
  games: { won: number; lost: number };
}

/** Every finished match's results in a league, with the division each counts in. */
async function gatherResults(league: LeagueRow): Promise<GatheredResult[]> {
  const fixtures = await getFixtures(league.id);
  const divisions = await getDivisions(league.id);
  const out: GatheredResult[] = [];
  const push = (r: ReturnType<typeof leagueResultsOfMatch>, divisionId: string, only?: Set<string>) => {
    for (const res of r.results) {
      if (only && !only.has(res.profileId)) continue;
      out.push({ result: res, divisionId, games: r.games.get(leaguePointsKey(res.matchId, res.profileId)) ?? { won: 0, lost: 0 } });
    }
  };

  // Sessions: nights (every match of the night) and season fixtures (their own match).
  const sessionIds = [...new Set(fixtures.filter((f) => f.session_id).map((f) => f.session_id!))];
  const sessions = await chunked<{ id: string; tournament_id: string }>(sessionIds, (part) => db().from("friendly_sessions").select("id, tournament_id").in("id", part));
  const tournamentOfSession = new Map(sessions.map((s) => [s.id, s.tournament_id]));
  const nightOfTournament = new Map<string, FixtureRow>();
  for (const f of fixtures) if (f.kind === "night" && f.session_id && tournamentOfSession.get(f.session_id)) nightOfTournament.set(tournamentOfSession.get(f.session_id)!, f);
  const matchFixture = new Map(fixtures.filter((f) => f.kind === "match" && f.match_id).map((f) => [f.match_id!, f]));

  const nightMatches = await chunked<MatchRow>([...nightOfTournament.keys()], (part) =>
    db().from("matches").select(MATCH_COLS).in("tournament_id", part).in("status", FINISHED),
  );
  const fixtureMatches = await chunked<MatchRow>([...matchFixture.keys()], (part) => db().from("matches").select(MATCH_COLS).in("id", part).in("status", FINISHED));
  const sessionMatches = [...nightMatches, ...fixtureMatches];
  const parts = await chunked<{
    match_id: string;
    team_a_player_one: string;
    team_a_player_two: string | null;
    team_b_player_one: string;
    team_b_player_two: string | null;
  }>(
    sessionMatches.map((m) => m.id),
    (part) => db().from("friendly_match_participants").select("match_id, team_a_player_one, team_a_player_two, team_b_player_one, team_b_player_two").in("match_id", part),
  );
  const partOf = new Map(parts.map((p) => [p.match_id, p]));

  // Tournaments counting toward a division: only that division's active members count.
  const tFixtures = fixtures.filter((f) => f.kind === "tournament" && f.tournament_id);
  const tournamentMatches = await chunked<MatchRow>(
    tFixtures.map((f) => f.tournament_id!),
    (part) => db().from("matches").select(MATCH_COLS).in("tournament_id", part).in("status", FINISHED),
  );

  const allMatches = [...sessionMatches, ...tournamentMatches];
  const snaps = await chunked<LeagueSnapshotInput & { match_id: string }>(
    allMatches.map((m) => m.id),
    (part) => db().from("match_score_snapshots").select("match_id, completed_sets, team_a_games, team_b_games").in("match_id", part),
  );
  const snapOf = new Map(snaps.map((s) => [s.match_id, s]));

  for (const m of nightMatches) {
    const f = nightOfTournament.get(m.tournament_id);
    const p = partOf.get(m.id);
    if (!f || !p) continue;
    push(leagueResultsOfMatch(m, { a: [p.team_a_player_one, p.team_a_player_two], b: [p.team_b_player_one, p.team_b_player_two] }, f.date, snapOf.get(m.id)), f.division_id);
  }
  for (const m of fixtureMatches) {
    const f = matchFixture.get(m.id);
    const p = partOf.get(m.id);
    if (!f || !p) continue;
    push(leagueResultsOfMatch(m, { a: [p.team_a_player_one, p.team_a_player_two], b: [p.team_b_player_one, p.team_b_player_two] }, f.date, snapOf.get(m.id)), f.division_id);
  }

  if (tournamentMatches.length) {
    const members = (await getMembers(league.id)).filter((x) => x.status === "active");
    const activeIn = new Map<string, Set<string>>();
    for (const d of divisions) activeIn.set(d.id, new Set(members.filter((x) => x.division_id === d.id).map((x) => x.player_profile_id)));
    const teamIds = tournamentMatches.flatMap((m) => [m.team_a_id, m.team_b_id]).filter((x): x is string => Boolean(x));
    const rubberPlayerIds = tournamentMatches.flatMap((m) => [...(m.team_a_player_ids ?? []), ...(m.team_b_player_ids ?? [])]);
    // Explicit columns: never a player's phone, email or code.
    const byTeam = await chunked<{ id: string; team_id: string; player_profile_id: string | null }>(teamIds, (part) =>
      db().from("players").select("id, team_id, player_profile_id").in("team_id", part),
    );
    const byId = await chunked<{ id: string; team_id: string; player_profile_id: string | null }>(rubberPlayerIds, (part) =>
      db().from("players").select("id, team_id, player_profile_id").in("id", part),
    );
    const profileOfPlayer = new Map([...byTeam, ...byId].map((p) => [p.id, p.player_profile_id]));
    const teamProfiles = new Map<string, string[]>();
    for (const p of byTeam) if (p.player_profile_id) teamProfiles.set(p.team_id, [...(teamProfiles.get(p.team_id) ?? []), p.player_profile_id]);
    const fixtureOfTournament = new Map(tFixtures.map((f) => [f.tournament_id!, f]));
    for (const m of tournamentMatches) {
      const f = fixtureOfTournament.get(m.tournament_id);
      if (!f) continue;
      // A rubber names who played it; any other match is its two teams' players.
      const side = (ids: string[] | null, team: string | null) =>
        ids && ids.length ? ids.map((id) => profileOfPlayer.get(id) ?? null) : team ? (teamProfiles.get(team) ?? []) : [];
      push(
        leagueResultsOfMatch(m, { a: side(m.team_a_player_ids, m.team_a_id), b: side(m.team_b_player_ids, m.team_b_id) }, f.date, snapOf.get(m.id)),
        f.division_id,
        activeIn.get(f.division_id) ?? new Set(),
      );
    }
  }
  return out;
}

export interface RecomputeOutcome {
  upserted: number;
  removed: number;
  rows: number;
}

/**
 * Brings a league's points rows in line with its results: computes every row
 * from the finished matches and writes only what changes (by match + player).
 */
export async function recomputeLeague(leagueId: string): Promise<RecomputeOutcome> {
  const league = await getLeague(leagueId);
  if (!league) return { upserted: 0, removed: 0, rows: 0 };
  // Read the stored rows first (see header).
  const { data: existingRaw } = await db()
    .from("league_points")
    .select("league_id, division_id, player_profile_id, match_id, kind, components, points, month, streak_after, games_won, games_lost")
    .eq("league_id", leagueId)
    .limit(100000);
  const existing = (existingRaw ?? []) as PointsRowDb[];
  const gathered = await gatherResults(league);
  const meta = new Map(gathered.map((g) => [leaguePointsKey(g.result.matchId, g.result.profileId), g]));
  const { rows } = leaguePoints(league.points_rules, gathered.map((g) => g.result), league.timezone);

  const wanted = new Map(rows.map((r) => [leaguePointsKey(r.matchId, r.profileId), r]));
  const have = new Map(existing.map((r) => [leaguePointsKey(r.match_id, r.player_profile_id), r]));
  const remove = [...have.keys()].filter((k) => !wanted.has(k));
  const upsert: Record<string, unknown>[] = [];
  for (const [k, r] of wanted) {
    const g = meta.get(k)!;
    const h = have.get(k);
    const same =
      h &&
      h.kind === r.kind &&
      h.month === r.month &&
      Number(h.points) === r.points &&
      (h.components?.base ?? 0) === r.components.base &&
      (h.components?.streak ?? 0) === r.components.streak &&
      h.streak_after === r.streakAfter &&
      h.division_id === g.divisionId &&
      h.games_won === g.games.won &&
      h.games_lost === g.games.lost;
    if (same) continue;
    upsert.push({
      league_id: leagueId,
      division_id: g.divisionId,
      player_profile_id: r.profileId,
      match_id: r.matchId,
      kind: r.kind,
      components: r.components,
      points: r.points,
      month: r.month,
      streak_after: r.streakAfter,
      games_won: g.games.won,
      games_lost: g.games.lost,
      updated_at: new Date().toISOString(),
    });
  }
  for (const k of remove) {
    const [matchId, profileId] = k.split("|");
    await db().from("league_points").delete().eq("league_id", leagueId).eq("match_id", matchId).eq("player_profile_id", profileId);
  }
  for (let i = 0; i < upsert.length; i += 200) {
    const { error } = await db().from("league_points").upsert(upsert.slice(i, i + 200), { onConflict: "match_id,player_profile_id" });
    if (error) throw new Error(`league points: ${error.message}`);
  }
  return { upserted: upsert.length, removed: remove.length, rows: rows.length };
}

/** Recomputes every league a match counts in. Never throws: a failure is logged (Admin → League → Recalculate fixes it). */
export async function recomputeLeaguesForMatch(match: { id: string; tournament_id: string }): Promise<void> {
  try {
    for (const id of await leaguesOfMatch(match)) await recomputeLeague(id);
  } catch (err) {
    console.error("league points recompute failed", (err as Error).message);
  }
}

/** Recomputes the league a tournament counts toward (after a reset or a deleted match). */
export async function recomputeLeaguesForTournament(tournamentId: string): Promise<void> {
  try {
    const { data } = await db().from("league_fixtures").select("league_id").eq("tournament_id", tournamentId);
    const ids = new Set(((data ?? []) as { league_id: string }[]).map((r) => r.league_id));
    for (const id of await leaguesOfMatch({ id: "", tournament_id: tournamentId })) ids.add(id);
    for (const id of ids) await recomputeLeague(id);
  } catch (err) {
    console.error("league points recompute failed", (err as Error).message);
  }
}

/* ---------------- boards ---------------- */

/** Today ("YYYY-MM-DD") in a league's time zone. */
export function todayIn(timeZone: string, now = Date.now()): string {
  try {
    return eventDay(timeZone || "Africa/Cairo", now);
  } catch {
    return eventDay("Africa/Cairo", now);
  }
}

/** The month "now" in a league's time zone. */
export function currentMonth(timeZone: string, now = Date.now()): string {
  return todayIn(timeZone, now).slice(0, 7);
}

function toEntry(r: PointsRowDb): BoardEntry {
  return {
    profileId: r.player_profile_id,
    month: r.month,
    points: Number(r.points),
    wins: r.kind === "win" || r.kind === "walkover_win" ? 1 : 0,
    losses: r.kind === "loss" || r.kind === "walkover_loss" ? 1 : 0,
    gamesWon: r.games_won,
    gamesLost: r.games_lost,
    played: 1,
    leagueId: r.league_id,
    kind: r.kind as BoardEntry["kind"],
  };
}

async function pointsRows(filter: { leagueIds: string[]; months: string[] }): Promise<PointsRowDb[]> {
  if (!filter.leagueIds.length || !filter.months.length) return [];
  const out: PointsRowDb[] = [];
  for (let i = 0; i < filter.leagueIds.length; i += 100) {
    const { data } = await db()
      .from("league_points")
      .select("league_id, division_id, player_profile_id, match_id, kind, components, points, month, streak_after, games_won, games_lost")
      .in("league_id", filter.leagueIds.slice(i, i + 100))
      .in("month", filter.months)
      .limit(100000);
    out.push(...((data ?? []) as PointsRowDb[]));
  }
  return out;
}

/**
 * Names to show for these profiles on a board of `orgId` (null: the platform), by
 * main's masking rule (orgDisplayNames over hiddenPersonFields): a profile the
 * organisation may not show is named as that organisation typed it, never by its
 * public name. On the platform board, `contributing` says which organisations'
 * leagues a player's points came from; any of them that may not show the player
 * hides the name.
 */
async function boardNames(ids: string[], orgId: string | null, contributing?: Map<string, Set<string>>): Promise<Map<string, string>> {
  if (orgId) return (await orgDisplayNames(orgId, ids)).names;
  const names = new Map<string, string>();
  const profiles = await chunked<{ id: string; public_name: string }>(ids, (part) => db().from("player_profiles").select("id, public_name").in("id", part));
  for (const p of profiles) names.set(p.id, p.public_name);
  const orgs = new Set([...(contributing?.values() ?? [])].flatMap((s) => [...s]));
  const masked = new Set<string>();
  for (const org of orgs) {
    const these = ids.filter((id) => contributing?.get(id)?.has(org) && !masked.has(id));
    const shown = await orgDisplayNames(org, these);
    for (const id of shown.hidden) {
      masked.add(id);
      names.set(id, shown.names.get(id) ?? UNNAMED_MATCHED);
    }
  }
  // With no contributing organisation to ask, nobody's public name is shown.
  for (const id of ids) if (!contributing?.get(id)?.size && !masked.has(id)) names.set(id, UNNAMED_MATCHED);
  for (const id of ids) if (!names.has(id)) names.set(id, UNNAMED_MATCHED);
  return names;
}

function toLines(board: BoardLine[], names: Map<string, string>, limit = 100): MBoardLine[] {
  return board.slice(0, limit).map((l) => ({
    rank: l.rank,
    name: names.get(l.profileId) ?? UNNAMED_MATCHED,
    points: l.points,
    wins: l.wins,
    losses: l.losses,
    played: l.played,
    gameDiff: l.gameDiff,
  }));
}

export function boardPeriod(league: Pick<LeagueRow, "periods" | "timezone">, lengthRaw: unknown, monthRaw: unknown): MBoardPeriod {
  const periods = leaguePeriods(league.periods);
  const asked = Number(lengthRaw);
  const length = (periods.boards.includes(asked as BoardLength) ? asked : 1) as BoardLength;
  const month = isMonth(monthRaw) ? monthRaw : currentMonth(league.timezone);
  return { length, label: BOARD_LABELS[length], month, months: boardMonths(month, length, periods.yearStartMonth) };
}

/** A league's boards for a period: the whole league, and per division. Removed members are left off. */
export async function leagueBoards(
  league: LeagueRow,
  period: MBoardPeriod,
): Promise<{ board: BoardLine[]; byDivision: Map<string, BoardLine[]>; names: Map<string, string> }> {
  const rows = await pointsRows({ leagueIds: [league.id], months: period.months });
  const { data: removedRows } = await db().from("league_members").select("player_profile_id").eq("league_id", league.id).eq("status", "removed");
  const removed = new Set(((removedRows ?? []) as { player_profile_id: string }[]).map((r) => r.player_profile_id));
  const kept = rows.filter((r) => !removed.has(r.player_profile_id));
  const board = rankBoard(kept.map(toEntry));
  const byDivision = new Map<string, BoardLine[]>();
  const divisions = new Set(kept.map((r) => r.division_id).filter((x): x is string => Boolean(x)));
  for (const d of divisions) byDivision.set(d, rankBoard(kept.filter((r) => r.division_id === d).map(toEntry)));
  const names = await boardNames(board.map((l) => l.profileId), league.organization_id);
  return { board, byDivision, names };
}

interface TopLeague {
  id: string;
  organization_id: string;
  counts_toward_top_of_all: boolean;
}

/** Leagues whose points can reach a top board: not drafts. */
async function topLeagues(orgId: string | null): Promise<TopLeague[]> {
  let q = db().from("leagues").select("id, organization_id, counts_toward_top_of_all").in("status", ["active", "closed", "archived"]).eq("counts_toward_top_of_all", true);
  if (orgId) q = q.eq("organization_id", orgId);
  const { data } = await q.limit(5000);
  return (data ?? []) as TopLeague[];
}

async function approvedOrgs(ids: string[]): Promise<Map<string, { slug: string; name: string; top_board_opt_out: boolean }>> {
  const rows = await chunked<{ id: string; slug: string; name: string; status: string; top_board_opt_out: boolean }>(ids, (part) =>
    db().from("organizations").select("id, slug, name, status, top_board_opt_out").in("id", part),
  );
  return new Map(rows.filter((o) => o.status === "approved").map((o) => [o.id, { slug: o.slug, name: o.name, top_board_opt_out: o.top_board_opt_out }]));
}

/**
 * "Top of all leagues" for a month: per organisation, or platform-wide without
 * the organisations that opted out (and without organisations that are not approved).
 */
export async function topBoard(scope: { organizationId: string } | "platform", monthRaw?: unknown): Promise<MTopBoard> {
  const month = isMonth(monthRaw) ? monthRaw : currentMonth("Africa/Cairo");
  const orgId = scope === "platform" ? null : scope.organizationId;
  return memo(`top:${orgId ?? "platform"}:${month}`, 3_000, async () => {
    const leagues = await topLeagues(orgId);
    const orgs = await approvedOrgs([...new Set(leagues.map((l) => l.organization_id))]);
    const eligible = leagues.filter((l) => orgs.has(l.organization_id));
    const rows = await pointsRows({ leagueIds: eligible.map((l) => l.id), months: [month] });
    const entries = rows.map(toEntry);
    const boardLeagues = eligible.map((l) => ({ id: l.id, organizationId: l.organization_id, countsTowardTopOfAll: l.counts_toward_top_of_all }));
    const optedOut = [...orgs].filter(([, o]) => o.top_board_opt_out).map(([id]) => id);
    const board =
      scope === "platform"
        ? topOfAllLeagues(entries, boardLeagues, { kind: "platform", optedOut }, month)
        : topOfAllLeagues(entries, boardLeagues, { kind: "organization", organizationId: scope.organizationId }, month);
    const orgOfLeague = new Map(eligible.map((l) => [l.id, l.organization_id]));
    const contributing = new Map<string, Set<string>>();
    for (const r of rows) {
      const o = orgOfLeague.get(r.league_id);
      if (!o) continue;
      contributing.set(r.player_profile_id, (contributing.get(r.player_profile_id) ?? new Set()).add(o));
    }
    const names = await boardNames(board.map((l) => l.profileId), orgId, contributing);
    const org = orgId ? orgs.get(orgId) : null;
    return {
      generatedAt: new Date().toISOString(),
      scope: scope === "platform" ? "platform" : "organization",
      organization: org ? { slug: org.slug, name: org.name } : null,
      month,
      lines: toLines(board, names, 50),
    };
  });
}

/* ---------------- the app's public views ---------------- */

function publicModes(raw: unknown): MJoinMode[] {
  return normalizeJoinModes(raw) as MJoinMode[];
}

/** Online payment for the Move Beyond organisation only, once a payment provider is configured (src/lib/payments/provider.ts). */
export function leaguePaymentsEnabled(orgSlug: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return orgSlug === MOVE_BEYOND_SLUG && paymentProvider(env) !== null;
}

async function orgRef(orgId: string): Promise<(MOrgRef & { approved: boolean }) | null> {
  const { data } = await db().from("organizations").select("slug, name, status").eq("id", orgId).maybeSingle();
  const o = data as { slug: string; name: string; status: string } | null;
  return o ? { slug: o.slug, name: o.name, approved: o.status === "approved" } : null;
}

/** A public league by slug: active or closed, of an approved organisation. */
export async function publicLeagueBySlug(slug: string): Promise<{ league: LeagueRow; org: MOrgRef } | null> {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$/.test(slug)) return null;
  const { data } = await db().from("leagues").select(LEAGUE_COLUMNS).eq("slug", slug).maybeSingle();
  const league = data as LeagueRow | null;
  if (!league || !(PUBLIC_LEAGUE_STATUSES as readonly string[]).includes(league.status)) return null;
  const org = await orgRef(league.organization_id);
  if (!org?.approved) return null;
  return { league, org: { slug: org.slug, name: org.name } };
}

/** Cards for an organisation's public leagues (or a list of leagues). */
export async function leagueCards(filter: { organizationId?: string; leagueIds?: string[] }, orgs?: Map<string, MOrgRef>): Promise<MLeagueCard[]> {
  let q = db().from("leagues").select(LEAGUE_COLUMNS).in("status", [...PUBLIC_LEAGUE_STATUSES]);
  if (filter.organizationId) q = q.eq("organization_id", filter.organizationId);
  if (filter.leagueIds) q = q.in("id", filter.leagueIds.length ? filter.leagueIds : ["00000000-0000-0000-0000-000000000000"]);
  const { data } = await q.order("created_at", { ascending: false }).limit(100);
  const leagues = (data ?? []) as LeagueRow[];
  if (!leagues.length) return [];
  const ids = leagues.map((l) => l.id);
  const [divs, members, fixtures] = await Promise.all([
    chunked<{ league_id: string }>(ids, (part) => db().from("league_divisions").select("league_id").in("league_id", part)),
    chunked<{ league_id: string }>(ids, (part) => db().from("league_members").select("league_id").in("league_id", part).eq("status", "active")),
    chunked<{ league_id: string; date: string }>(ids, (part) => db().from("league_fixtures").select("league_id, date").in("league_id", part)),
  ]);
  const count = (rows: { league_id: string }[], id: string) => rows.filter((r) => r.league_id === id).length;
  const refs = orgs ?? new Map<string, MOrgRef>();
  if (!orgs) {
    const approved = await approvedOrgs([...new Set(leagues.map((l) => l.organization_id))]);
    for (const [id, o] of approved) refs.set(id, { slug: o.slug, name: o.name });
  }
  return leagues
    .filter((l) => refs.has(l.organization_id))
    .map((l) => {
      const today = todayIn(l.timezone);
      const next = fixtures.filter((f) => f.league_id === l.id && f.date >= today).map((f) => f.date).sort()[0] ?? null;
      return {
        slug: l.slug,
        name: l.name,
        sport: l.sport,
        kind: l.kind,
        status: l.status as "active" | "closed",
        organization: refs.get(l.organization_id) ?? null,
        divisions: count(divs, l.id),
        members: count(members, l.id),
        nextDate: next,
        joinModes: publicModes(l.join_modes),
      };
    });
}

function scoreLine(snap: { completed_sets?: { teamAGames?: number; teamBGames?: number }[] | null } | null | undefined): string | null {
  const sets = Array.isArray(snap?.completed_sets) ? snap!.completed_sets! : [];
  return sets.length ? sets.map((s) => `${s.teamAGames ?? 0}-${s.teamBGames ?? 0}`).join(" ") : null;
}

/** A league's public page: settings people need, boards for the period, nights and fixtures. */
export async function getPublicLeague(slug: string, lengthRaw?: unknown, monthRaw?: unknown): Promise<MLeague | null> {
  const found = await publicLeagueBySlug(slug);
  if (!found) return null;
  const { league, org } = found;
  const period = boardPeriod(league, lengthRaw, monthRaw);
  return memo(`league:${league.id}:${league.updated_at}:${period.length}:${period.month}`, 2_000, async () => {
    const [divisions, fixtures, memberRows, boards] = await Promise.all([
      getDivisions(league.id),
      getFixtures(league.id),
      db().from("league_members").select("division_id").eq("league_id", league.id).eq("status", "active").limit(5000),
      leagueBoards(league, period),
    ]);
    const divName = new Map(divisions.map((d) => [d.id, d.name]));
    const memberCount = (id: string) => ((memberRows.data ?? []) as { division_id: string | null }[]).filter((m) => m.division_id === id).length;

    // Nights: their session's hidden tournament, which the app opens like a tournament.
    const nightFixtures = fixtures.filter((f) => f.kind === "night" && f.session_id);
    const sessions = await chunked<{ id: string; tournament_id: string; name: string }>(nightFixtures.map((f) => f.session_id!), (part) =>
      db().from("friendly_sessions").select("id, tournament_id, name").in("id", part),
    );
    const sessionOf = new Map(sessions.map((s) => [s.id, s]));
    const tIds = sessions.map((s) => s.tournament_id);
    const [tRows, nightMatches] = await Promise.all([
      chunked<{ id: string; slug: string; format_config: { nightTable?: { publishedAt?: string } } | null }>(tIds, (part) => db().from("tournaments").select("id, slug, format_config").in("id", part)),
      chunked<{ tournament_id: string; status: string }>(tIds, (part) => db().from("matches").select("tournament_id, status").in("tournament_id", part)),
    ]);
    const slugOf = new Map(tRows.map((t) => [t.id, t.slug]));
    const publishedOf = new Map(tRows.map((t) => [t.id, t.format_config?.nightTable?.publishedAt ?? null]));
    // The table (Phase 8) for the nights that are on or coming up: from yesterday on, still to finish, a few at most.
    const since = addDays(todayIn(league.timezone), -1);
    const current = new Set(
      nightFixtures
        .filter((f) => {
          const s = sessionOf.get(f.session_id!);
          const ms = nightMatches.filter((m) => m.tournament_id === s?.tournament_id);
          return s && f.date >= since && ms.length > 0 && ms.some((m) => !FINISHED.includes(m.status) && m.status !== "cancelled");
        })
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        .slice(0, 4)
        .map((f) => f.session_id!),
    );
    const tables = new Map<string, MNightTable>();
    if (current.size) {
      const { nightTableFor } = await import("../friendly/nights");
      for (const sid of current) {
        const view = await nightTableFor(sessionOf.get(sid)!.tournament_id);
        if (view && (view.publishedAt || view.estimated)) tables.set(sid, view.table);
      }
    }
    const nights: MLeagueNight[] = nightFixtures.map((f) => {
      const s = sessionOf.get(f.session_id!);
      const ms = nightMatches.filter((m) => m.tournament_id === s?.tournament_id);
      return {
        date: f.date,
        name: s?.name ?? "Night",
        slug: s ? (slugOf.get(s.tournament_id) ?? "") : "",
        liveCount: ms.filter((m) => m.status === "live" || m.status === "paused").length,
        matches: ms.length,
        finished: ms.filter((m) => FINISHED.includes(m.status)).length,
        division: divName.get(f.division_id) ?? "",
        publishedAt: s ? (publishedOf.get(s.tournament_id) ?? null) : null,
        table: tables.get(f.session_id!) ?? null,
      };
    });

    // Season fixtures: who meets whom, when, and the result.
    const matchFixtures = fixtures.filter((f) => f.kind === "match" && f.match_id);
    const fMatches = await chunked<{ id: string; status: string; tournament_id: string }>(matchFixtures.map((f) => f.match_id!), (part) =>
      db().from("matches").select("id, status, tournament_id").in("id", part),
    );
    const fSnaps = await chunked<{ match_id: string; completed_sets: { teamAGames?: number; teamBGames?: number }[] | null }>(fMatches.map((m) => m.id), (part) =>
      db().from("match_score_snapshots").select("match_id, completed_sets").in("match_id", part),
    );
    const fMatchOf = new Map(fMatches.map((m) => [m.id, m]));
    const fSnapOf = new Map(fSnaps.map((s) => [s.match_id, s]));
    const seasonTournaments = await chunked<{ id: string; slug: string }>([...new Set(fMatches.map((m) => m.tournament_id))], (part) =>
      db().from("tournaments").select("id, slug").in("id", part),
    );
    const seasonSlug = new Map(seasonTournaments.map((t) => [t.id, t.slug]));
    const memberIds = matchFixtures.flatMap((f) => [f.home_member_id, f.away_member_id]).filter((x): x is string => Boolean(x));
    const mRows = await chunked<{ id: string; player_profile_id: string; partner_profile_id: string | null }>(memberIds, (part) =>
      db().from("league_members").select("id, player_profile_id, partner_profile_id").in("id", part),
    );
    const names = await boardNames(
      [...new Set(mRows.flatMap((m) => [m.player_profile_id, m.partner_profile_id]).filter((x): x is string => Boolean(x)))],
      league.organization_id,
    );
    const entrantName = (memberId: string | null) => {
      const m = mRows.find((x) => x.id === memberId);
      if (!m) return "TBD";
      return [m.player_profile_id, m.partner_profile_id].filter((x): x is string => Boolean(x)).map((id) => names.get(id) ?? UNNAMED_MATCHED).join(" & ");
    };
    const fixturesOut: MLeagueFixture[] = matchFixtures.map((f) => {
      const m = fMatchOf.get(f.match_id!);
      const status: MLeagueFixture["status"] = !m ? "scheduled" : FINISHED.includes(m.status) ? "finished" : ["live", "paused", "pending_sync"].includes(m.status) ? "live" : "scheduled";
      return {
        date: f.date,
        round: f.round,
        division: divName.get(f.division_id) ?? "",
        home: entrantName(f.home_member_id),
        away: entrantName(f.away_member_id),
        status,
        score: status === "finished" ? scoreLine(fSnapOf.get(f.match_id!)) : null,
        matchId: m ? m.id : null,
        slug: m ? (seasonSlug.get(m.tournament_id) ?? null) : null,
      };
    });

    const fee = leagueFee(league.fee);
    const rules = leaguePointsRules(league.points_rules);
    const periods = leaguePeriods(league.periods);
    const modes = publicModes(league.join_modes);
    const paidMode = modes.includes("paid") && fee.membership !== null;
    return {
      generatedAt: new Date().toISOString(),
      league: {
        slug: league.slug,
        name: league.name,
        about: league.about,
        sport: league.sport,
        kind: league.kind,
        status: league.status as "active" | "closed",
        timezone: league.timezone,
        organization: org,
        joinModes: modes,
        takingMembers: leagueTakesMembers(league.status),
        fee: { membership: moneyLabel(fee.membership), perNight: moneyLabel(fee.perNight), payAtVenue: paidMode && !leaguePaymentsEnabled(org.slug) },
        points: { win: rules.win, draw: rules.draw, loss: rules.loss, walkoverWin: rules.walkoverWin, walkoverLoss: rules.walkoverLoss, streak: { ...rules.streak } },
        boards: periods.boards,
        yearStartMonth: periods.yearStartMonth,
      },
      period,
      board: toLines(boards.board, boards.names),
      divisions: divisions.map((d) => ({ id: d.id, name: d.name, members: memberCount(d.id), board: toLines(boards.byDivision.get(d.id) ?? [], boards.names) })),
      nights: nights.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
      fixtures: fixturesOut,
    };
  });
}

/* ---------------- the signed-in account ---------------- */

/** The account's leagues, with this month's rank in each (never cached). `onlySlug` narrows to one league. */
export async function myLeagues(userId: string, onlySlug?: string): Promise<MMyLeagues> {
  const me = await profileForUser(userId);
  if (!me) return { generatedAt: new Date().toISOString(), profileLinked: false, leagues: [] };
  const { data } = await db().from("league_members").select(MEMBER_COLUMNS).eq("player_profile_id", me.profileId).limit(200);
  const rows = (data ?? []) as MemberRow[];
  const leagues = await chunked<LeagueRow>(rows.map((r) => r.league_id), (part) => db().from("leagues").select(LEAGUE_COLUMNS).in("id", part));
  const visible = leagues.filter((l) => (PUBLIC_LEAGUE_STATUSES as readonly string[]).includes(l.status) && (!onlySlug || l.slug === onlySlug));
  const orgs = await approvedOrgs([...new Set(visible.map((l) => l.organization_id))]);
  const divisions = await chunked<{ id: string; name: string }>(rows.map((r) => r.division_id ?? ""), (part) => db().from("league_divisions").select("id, name").in("id", part));
  const out: MMyLeague[] = [];
  for (const l of visible) {
    const o = orgs.get(l.organization_id);
    if (!o) continue;
    const m = rows.find((r) => r.league_id === l.id)!;
    const month = currentMonth(l.timezone);
    let rank: number | null = null;
    let points = 0;
    if (m.status === "active") {
      const pts = await pointsRows({ leagueIds: [l.id], months: [month] });
      const line = rankBoard(pts.map(toEntry)).find((x) => x.profileId === me.profileId);
      rank = line?.rank ?? null;
      points = line?.points ?? 0;
    }
    out.push({
      slug: l.slug,
      name: l.name,
      organization: { slug: o.slug, name: o.name },
      status: m.status,
      division: divisions.find((d) => d.id === m.division_id)?.name ?? null,
      payAtVenue: m.pay_at_venue,
      month,
      rank,
      points,
    });
  }
  return { generatedAt: new Date().toISOString(), profileLinked: true, leagues: out };
}

/* ---------------- joining ---------------- */

export type JoinOutcome =
  | { ok: true; outcome: "joined" | "pending_approval" | "payment_required"; status: MembershipStatus; payAtVenue: boolean; message: string }
  | { ok: false; status: number; code: string; error: string };

const JOIN_REFUSALS: Record<string, [number, string]> = {
  sign_in: [401, "Sign in to join a league."],
  closed: [409, "This league is not taking members right now."],
  already_member: [409, "You're already in this league."],
  already_pending: [409, "Your request is waiting for the organiser."],
  removed: [403, "The organiser removed you from this league. Ask them to add you back."],
  invite_code_required: [403, "This league needs an invite code from the organiser."],
  invite_code_wrong: [403, "That invite code doesn't match. Check it with the organiser."],
};

/**
 * An app account asks to join a public league. Needs a linked player profile.
 * The invite code is compared with its stored hash (guesses rate-limited); the
 * join modes decide the rest (src/lib/leagues/join.ts). Joining makes the player
 * one of the organisation's players as 'matched' (addAsOrgPlayer: it vouches for nothing).
 */
export async function joinLeague(input: { slug: string; userId: string; code?: unknown; divisionId?: unknown }): Promise<JoinOutcome> {
  const found = await publicLeagueBySlug(input.slug);
  if (!found) return { ok: false, status: 404, code: "not_found", error: "League not found" };
  const { league, org } = found;
  const me = await profileForUser(input.userId);
  if (!me) {
    return { ok: false, status: 409, code: "link_profile", error: "Link your player profile first: enter your player code in Account, then join." };
  }
  const divisions = await getDivisions(league.id);
  let divisionId: string | null = null;
  if (input.divisionId !== undefined && input.divisionId !== null && input.divisionId !== "") {
    const d = divisions.find((x) => x.id === input.divisionId);
    if (!d) return { ok: false, status: 400, code: "division", error: "Pick one of this league's divisions." };
    divisionId = d.id;
  } else if (divisions.length === 1) divisionId = divisions[0].id;

  const { data: existingRow } = await db().from("league_members").select(MEMBER_COLUMNS).eq("league_id", league.id).eq("player_profile_id", me.profileId).maybeSingle();
  const existing = existingRow as MemberRow | null;

  const modes = normalizeJoinModes(league.join_modes) as JoinMode[];
  let inviteCode: { valid: boolean } | null = null;
  if (modes.includes("invite_code") && typeof input.code === "string" && input.code.trim()) {
    // Counted before the compare, atomically (a wave of guesses cannot all read the same count).
    const { takeRateLimit } = await import("../ratelimit");
    const limit = await takeRateLimit({ key: `league-code:${input.userId}`, limit: 8, windowSeconds: 900 });
    if (!limit.allowed) return { ok: false, status: 429, code: "too_many", error: "Too many tries. Wait a few minutes and try again." };
    const { data: h } = await db().from("leagues").select("invite_code_hash").eq("id", league.id).maybeSingle();
    inviteCode = { valid: leagueInviteCodeMatches(input.code, (h as { invite_code_hash: string | null } | null)?.invite_code_hash) };
  }

  const fee = leagueFee(league.fee);
  const paymentsEnabled = leaguePaymentsEnabled(org.slug);
  const decision = joinDecision(
    { joinModes: modes, closed: !leagueTakesMembers(league.status), membershipFee: fee.membership, paymentsEnabled },
    { signedIn: true, membership: existing?.status ?? null, inviteCode },
  );
  if (decision.outcome === "refused") {
    const [status, error] = JOIN_REFUSALS[decision.reason] ?? [409, "You can't join this league right now."];
    return { ok: false, status, code: decision.reason, error };
  }
  const status: MembershipStatus =
    decision.outcome === "join" ? "active" : decision.outcome === "pending_approval" ? "pending" : "awaiting_payment";
  const payAtVenue = decision.outcome === "payment_required" ? false : decision.payAtVenue;
  const row = {
    league_id: league.id,
    division_id: divisionId ?? existing?.division_id ?? null,
    player_profile_id: me.profileId,
    auth_user_id: input.userId,
    status,
    pay_at_venue: payAtVenue,
    source: "app",
    updated_at: new Date().toISOString(),
  };
  const { error } = existing
    ? await db().from("league_members").update(row).eq("id", existing.id)
    : await db().from("league_members").insert(row);
  if (error) return { ok: false, status: 409, code: "conflict", error: "Could not join right now. Try again." };

  await addAsOrgPlayer(league.organization_id, me);
  const { audit } = await import("../audit");
  await audit({
    organization_id: league.organization_id,
    actor_role: "user",
    action: "LEAGUE_JOIN_REQUESTED",
    entity_type: "league",
    entity_id: league.id,
    new_value: { status, pay_at_venue: payAtVenue, division_id: row.division_id },
  });
  const outcome = decision.outcome === "join" ? "joined" : decision.outcome;
  const message =
    outcome === "joined"
      ? payAtVenue
        ? `You're in. Pay the ${moneyLabel(fee.membership)} membership at the venue.`
        : "You're in."
      : outcome === "pending_approval"
        ? "Request sent. The organiser approves new members."
        : "Approved — pay the membership to finish joining.";
  return { ok: true, outcome, status, payAtVenue, message };
}

/**
 * The player becomes one of the organisation's players, never changing an existing
 * relation. Joining vouches for nothing: the relation is 'matched' with the
 * player's public name as the name the organisation sees, so the organisation sees
 * no contact field of a profile another organisation also has until the player
 * shares their details with it (My profile → Organisations, which records 'link').
 */
export async function addAsOrgPlayer(orgId: string, me: UserProfile): Promise<void> {
  await ensureOrgPlayer(orgId, me.profileId, "matched", "approved", me.publicName);
}

/** Every board length a league can show, for validating input. */
export const ALL_BOARD_LENGTHS = BOARD_LENGTHS;
