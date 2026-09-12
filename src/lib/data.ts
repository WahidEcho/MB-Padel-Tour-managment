import { db } from "./supabase";
import type {
  Bracket,
  BracketSlot,
  Court,
  Group,
  GroupTeam,
  Match,
  BracketTier,
  MatchSnapshot,
  PhotoFields,
  Player,
  ScreenSettings,
  Standing,
  Team,
  Tournament,
} from "./types";
import { resolvePortrait } from "./portrait";

export async function getTournament(id: string): Promise<Tournament | null> {
  const { data } = await db().from("tournaments").select("*").eq("id", id).maybeSingle();
  return data as Tournament | null;
}

export async function getTournamentBySlug(slug: string): Promise<Tournament | null> {
  const { data } = await db().from("tournaments").select("*").eq("slug", slug).maybeSingle();
  return data as Tournament | null;
}

/**
 * Teams with their players, each player's portrait already resolved.
 *
 * The profile embed lists its four columns rather than using `*`: this feeds
 * public pages and the venue screen, and `player_profiles` holds the mobile
 * number, which is the identity key and must never leave the server.
 *
 * The profile's values are folded onto the player row and the embed dropped, so
 * every caller keeps seeing a plain `Player` and nothing has to know that a
 * friendly-session player's photo lives somewhere else.
 */
export async function getTeams(tournamentId: string): Promise<Team[]> {
  const { data } = await db()
    .from("teams")
    .select("*, players(*, player_profiles(photo_url, portrait_url, focal_x, focal_y))")
    .eq("tournament_id", tournamentId)
    .order("team_name");
  const teams = (data ?? []) as Team[];
  for (const t of teams) {
    t.players?.sort((a, b) => a.player_order - b.player_order);
    for (const p of t.players ?? []) foldProfilePortrait(p);
  }
  return teams;
}

type WithProfile = Player & { player_profiles?: Partial<PhotoFields> | null };

/** Copies a linked profile's photo fields onto the player row, in place. */
export function foldProfilePortrait(player: Player): Player {
  const withProfile = player as WithProfile;
  const profile = withProfile.player_profiles;
  const resolved = resolvePortrait(player, profile);
  player.photo_url = resolved.photoUrl;
  player.portrait_url = resolved.portraitUrl;
  player.focal_x = resolved.focalX;
  player.focal_y = resolved.focalY;
  delete withProfile.player_profiles;
  return player;
}

export async function getCourts(tournamentId: string): Promise<Court[]> {
  const { data } = await db()
    .from("courts")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("court_order");
  return (data ?? []) as Court[];
}

export async function getGroups(tournamentId: string): Promise<Group[]> {
  const { data } = await db()
    .from("groups")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("group_order");
  return (data ?? []) as Group[];
}

export async function getGroupTeams(tournamentId: string): Promise<GroupTeam[]> {
  const { data } = await db()
    .from("group_teams")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("position");
  return (data ?? []) as GroupTeam[];
}

export async function getMatches(tournamentId: string): Promise<Match[]> {
  const { data } = await db()
    .from("matches")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("match_order");
  return (data ?? []) as Match[];
}

export async function getMatch(matchId: string): Promise<Match | null> {
  const { data } = await db().from("matches").select("*").eq("id", matchId).maybeSingle();
  return data as Match | null;
}

export async function getSnapshots(tournamentId: string): Promise<MatchSnapshot[]> {
  const { data } = await db()
    .from("match_score_snapshots")
    .select("*")
    .eq("tournament_id", tournamentId);
  return (data ?? []) as MatchSnapshot[];
}

export async function getSnapshot(matchId: string): Promise<MatchSnapshot | null> {
  const { data } = await db()
    .from("match_score_snapshots")
    .select("*")
    .eq("match_id", matchId)
    .maybeSingle();
  return data as MatchSnapshot | null;
}

/**
 * The score just before a finished match's winning point, so any referee device
 * can undo it — not only the tablet that confirmed. A reloaded or second tablet
 * starts with no local history, which left "Undo (reopen match)" doing nothing.
 *
 * The most recent event that crossed into match-over is the finishing point; its
 * previous state is what an undo restores. Undos and re-scores after it are
 * newer events, so the latest crossing is always the one that stands. Null for a
 * match that never finished on the scoreboard (a walkover, a retirement).
 */
export async function getReopenState(matchId: string): Promise<Record<string, unknown> | null> {
  const { data } = await db()
    .from("score_events")
    .select("event_number, previous_state_json, new_state_json")
    .eq("match_id", matchId)
    .order("event_number", { ascending: false })
    .limit(50);
  type Row = { previous_state_json: { matchOver?: boolean } | null; new_state_json: { matchOver?: boolean } | null };
  const crossing = ((data ?? []) as Row[]).find(
    (e) => e.new_state_json?.matchOver === true && e.previous_state_json && e.previous_state_json.matchOver !== true,
  );
  return (crossing?.previous_state_json as Record<string, unknown> | undefined) ?? null;
}

export async function getStandings(tournamentId: string): Promise<Standing[]> {
  const { data } = await db()
    .from("standings_snapshots")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("rank");
  return (data ?? []) as Standing[];
}

/** One tier's bracket, or null. Defaults to the Cup, which is the only tier a
 * single-bracket tournament has. */
export async function getBracket(
  tournamentId: string,
  tier: BracketTier = "cup",
): Promise<Bracket | null> {
  const { data } = await db()
    .from("brackets")
    .select("*")
    .eq("tournament_id", tournamentId)
    .eq("tier", tier)
    .maybeSingle();
  return (data as Bracket | null) ?? null;
}

/** Which tier a match belongs to, or null when it is not a bracket match. */
export async function tierForMatch(match: Pick<Match, "bracket_id">): Promise<BracketTier | null> {
  if (!match.bracket_id) return null;
  const { data } = await db().from("brackets").select("tier").eq("id", match.bracket_id).maybeSingle();
  return ((data as { tier: BracketTier } | null)?.tier) ?? null;
}

/** Every bracket a tournament has, Cup first. */
export async function getBrackets(tournamentId: string): Promise<Bracket[]> {
  const { data } = await db().from("brackets").select("*").eq("tournament_id", tournamentId);
  const rows = (data ?? []) as Bracket[];
  return rows.sort((a, b) => (a.tier === "cup" ? -1 : b.tier === "cup" ? 1 : 0));
}

export async function getBracketSlots(bracketId: string): Promise<BracketSlot[]> {
  const { data } = await db()
    .from("bracket_slots")
    .select("*")
    .eq("bracket_id", bracketId)
    .order("slot_order");
  return (data ?? []) as BracketSlot[];
}

/** The shape of a screen that has no row yet. Never written by a reader. */
export function defaultScreenSettings(tournamentId: string, screenKey = "main"): ScreenSettings {
  return {
    id: "",
    tournament_id: tournamentId,
    screen_key: screenKey,
    screen_name: null,
    display_mode: "leaderboard",
    court_ids: [],
    focus_court_id: null,
    focus_match_id: null,
    bracket_tier: "cup",
    theme: "dark",
    sponsor_rotation_seconds: 10,
    revision: 0,
    break_started_at: null,
    break_ends_at: null,
    mute_animations: false,
    ceremony_step: 0,
    ceremony_step_at: null,
    entrance_replay: null,
  };
}

/**
 * One screen's settings, or null when there is no such screen.
 *
 * A pure read. It used to create the row on a miss, which was harmless while
 * only the operator console called it — but the TV route is public and now
 * carries the key in its URL, so creating on read would let any visitor make
 * rows, and a screen an admin deleted would be resurrected by the next poll of
 * a TV still open on it. Creation lives in `createScreen`, behind a permission.
 */
export async function getScreenSettings(
  tournamentId: string,
  screenKey = "main",
): Promise<ScreenSettings | null> {
  const { data } = await db()
    .from("screen_settings")
    .select("*")
    .eq("tournament_id", tournamentId)
    .eq("screen_key", screenKey)
    .maybeSingle();
  return (data as ScreenSettings | null) ?? null;
}

/** Every screen configured for a tournament, `main` first then by name. */
export async function listScreens(tournamentId: string): Promise<ScreenSettings[]> {
  const { data } = await db()
    .from("screen_settings")
    .select("*")
    .eq("tournament_id", tournamentId);
  const rows = (data ?? []) as ScreenSettings[];
  return rows.sort((a, b) => {
    if (a.screen_key === "main") return -1;
    if (b.screen_key === "main") return 1;
    return (a.screen_name ?? a.screen_key).localeCompare(b.screen_name ?? b.screen_key);
  });
}

/**
 * The courts a screen covers, in court order.
 *
 * Intersected with the courts that still exist, because `court_ids` is a plain
 * array with no foreign key: deleting a court would otherwise leave every
 * screen pointing at something gone. An empty list means every court, which is
 * what keeps screens that predate multi-court coverage working unchanged.
 */
export function courtsForScreen(settings: Pick<ScreenSettings, "court_ids">, courts: Court[]): Court[] {
  if (!settings.court_ids?.length) return courts;
  const wanted = new Set(settings.court_ids);
  return courts.filter((c) => wanted.has(c.id));
}

export function teamMap(teams: Team[]): Map<string, Team> {
  return new Map(teams.map((t) => [t.id, t]));
}
