/**
 * Read-side data access for friendly sessions.
 * Mirrors the conventions in `src/lib/data.ts`: server-only, one query per
 * getter, plain row types, no mutations.
 */
import { db } from "../supabase";
import type {
  FriendlyEntry,
  FriendlyMatchParticipants,
  FriendlyPair,
  FriendlyRankingSnapshot,
  FriendlySession,
  LedgerRow,
  PhotoFields,
  PlayerProfile,
  PublicPlayer,
  RankingCategory,
  Season,
} from "../types";
import { DEFAULT_FOCAL } from "../portrait";
import { orgTournamentIds } from "../orgs/scope";
import { maskPersonFields, matchedElsewhere, visiblePersonFields } from "../orgs/personFields";

/* ---------------- Sessions ---------------- */

export async function getSession(id: string): Promise<FriendlySession | null> {
  const { data } = await db().from("friendly_sessions").select("*").eq("id", id).maybeSingle();
  return data as FriendlySession | null;
}

export async function getSessionBySlug(slug: string): Promise<FriendlySession | null> {
  const { data } = await db().from("friendly_sessions").select("*").eq("slug", slug).maybeSingle();
  return data as FriendlySession | null;
}

/** Look a session up from the tournament row that backs it. */
export async function getSessionByTournament(
  tournamentId: string
): Promise<FriendlySession | null> {
  const { data } = await db()
    .from("friendly_sessions")
    .select("*")
    .eq("tournament_id", tournamentId)
    .maybeSingle();
  return data as FriendlySession | null;
}

/** An organisation's sessions (a session's organisation is its hidden tournament's). */
export async function listSessions(orgId: string, seasonId?: string): Promise<FriendlySession[]> {
  const ids = await orgTournamentIds(orgId, ["friendly_session"]);
  if (ids.length === 0) return [];
  const out: FriendlySession[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    let q = db().from("friendly_sessions").select("*").in("tournament_id", ids.slice(i, i + 200));
    if (seasonId) q = q.eq("season_id", seasonId);
    const { data } = await q;
    out.push(...((data ?? []) as FriendlySession[]));
  }
  const at = (s: FriendlySession) => (s.starts_at ? Date.parse(s.starts_at) : -Infinity);
  return out.sort((a, b) => at(b) - at(a));
}

/* ---------------- Seasons and categories ---------------- */

/** An organisation's seasons. */
export async function listSeasons(orgId: string): Promise<Season[]> {
  const { data } = await db()
    .from("seasons")
    .select("*")
    .eq("organization_id", orgId)
    .order("starts_on", { ascending: false, nullsFirst: false });
  return (data ?? []) as Season[];
}

export async function getActiveSeason(orgId: string): Promise<Season | null> {
  const { data } = await db()
    .from("seasons")
    .select("*")
    .eq("organization_id", orgId)
    .eq("status", "active")
    .maybeSingle();
  return data as Season | null;
}

export async function listRankingCategories(orgId: string): Promise<RankingCategory[]> {
  const { data } = await db()
    .from("ranking_categories")
    .select("*")
    .eq("organization_id", orgId)
    .order("sort_order")
    .order("name");
  return (data ?? []) as RankingCategory[];
}

/* ---------------- Player profiles ---------------- */

/**
 * The columns an admin page reads from a profile. Spelled out rather than `*`,
 * so a column added to player_profiles later (a private one) never reaches an
 * admin page — or another organisation — by default.
 */
export const ADMIN_PROFILE_COLUMNS =
  "id, public_name, mobile_normalized, approval_status, active_streak, streak_last_ledger_id, merged_into_profile_id, claim_status, email, birth_year, skill_level, gender, notes, photo_url, portrait_url, focal_x, focal_y, created_at, updated_at";

/**
 * Admin-only: the organisation's players, with its own (org-private) approval,
 * notes and level. The person's own fields (mobile, email, birth year, gender,
 * photo) are masked on a profile this organisation may not see them on
 * (src/lib/orgs/personFields.ts): it only matched an existing player by the
 * number typed on its public form, and another organisation has the player.
 * Never pass the result of this to a public page — use `listPublicPlayers`
 * or `toPublicPlayer` instead.
 */
export async function listPlayerProfiles(orgId: string, search?: string, opts: { platformAdmin?: boolean } = {}): Promise<PlayerProfile[]> {
  const { data: mine } = await db()
    .from("organization_players")
    .select("player_profile_id, approval_status, notes, level, typed_name")
    .eq("organization_id", orgId)
    .limit(20000);
  const own = new Map(
    ((mine ?? []) as { player_profile_id: string; approval_status: PlayerProfile["approval_status"]; notes: string | null; level: string | null; typed_name: string | null }[]).map((r) => [r.player_profile_id, r]),
  );
  const ids = [...own.keys()];
  const visible = await visiblePersonFields(orgId, ids, opts);
  const out: PlayerProfile[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db().from("player_profiles").select(`${ADMIN_PROFILE_COLUMNS}, auth_user_id`).is("merged_into_profile_id", null).in("id", ids.slice(i, i + 200));
    for (const p of (data ?? []) as unknown as PlayerProfile[]) {
      const o = own.get(p.id)!;
      // Which account is never shown; whether there is one is, to an organisation that sees the person.
      const row: PlayerProfile = { ...p, auth_user_id: null, app_linked: Boolean(p.auth_user_id), approval_status: p.approval_status === "merged" ? "merged" : o.approval_status, notes: o.notes, skill_level: o.level };
      out.push(visible.has(p.id) ? row : { ...maskPersonFields(row, o.typed_name), app_linked: false });
    }
  }
  // Searched after masking: a hidden profile is found by the name this organisation
  // sees (the typed one), never by its public name (which would confirm a guess).
  const needle = search?.trim().toLowerCase();
  const found = needle ? out.filter((p) => p.public_name.toLowerCase().includes(needle)) : out;
  return found.sort((a, b) => a.public_name.localeCompare(b.public_name));
}

/** One profile, by id (server use). Not organisation-scoped: callers check the organisation first. */
export async function getPlayerProfile(id: string): Promise<PlayerProfile | null> {
  const { data } = await db().from("player_profiles").select(ADMIN_PROFILE_COLUMNS).eq("id", id).maybeSingle();
  return data as unknown as PlayerProfile | null;
}

/** Find an existing profile by canonical mobile. Server use only; never shown to an organisation as is. */
export async function findProfileByMobile(
  mobileNormalized: string
): Promise<PlayerProfile | null> {
  const { data } = await db()
    .from("player_profiles")
    .select(ADMIN_PROFILE_COLUMNS)
    .eq("mobile_normalized", mobileNormalized)
    .maybeSingle();
  return data as unknown as PlayerProfile | null;
}

/** Strip a profile down to what public pages are allowed to see. */
/**
 * The columns a public page may see. Spelled out rather than selected with `*`,
 * so a column added to `player_profiles` later cannot leak by default — the
 * mobile number is the identity key here and must never reach a public page.
 */
export const PUBLIC_PLAYER_COLUMNS =
  "id, public_name, approval_status, photo_url, portrait_url, focal_x, focal_y";

type PublicPlayerRow = Pick<PlayerProfile, "id" | "public_name"> &
  Partial<PhotoFields> & { approval_status?: PlayerProfile["approval_status"] };

/**
 * A photo only becomes public once an admin has approved the player.
 *
 * Players may upload their own photo when they register, and a registration is
 * pending until someone approves it — so withholding the face here is what
 * stops an unreviewed image reaching a public page or the venue wall. The name
 * is unaffected: it was already reviewed the same way.
 */
export function toPublicPlayer(p: PublicPlayerRow): PublicPlayer {
  const approved = p.approval_status === undefined || p.approval_status === "approved";
  return {
    id: p.id,
    public_name: p.public_name,
    photo_url: approved ? p.photo_url ?? null : null,
    portrait_url: approved ? p.portrait_url ?? null : null,
    focal_x: p.focal_x ?? DEFAULT_FOCAL[0],
    focal_y: p.focal_y ?? DEFAULT_FOCAL[1],
  };
}

/**
 * Public-safe lookup for a set of profile ids: names and faces, nothing else.
 * `orgId`: the organisation whose page, ranking or screen this is. A profile it
 * only matched by a typed mobile (src/lib/orgs/personFields.ts) shows the name
 * typed on its form and no photo. Every caller showing an organisation's
 * players passes it.
 */
export async function listPublicPlayers(ids: string[], orgId: string | null): Promise<Map<string, PublicPlayer>> {
  if (ids.length === 0) return new Map();
  const [{ data }, masked] = await Promise.all([
    db().from("player_profiles").select(PUBLIC_PLAYER_COLUMNS).in("id", ids),
    matchedElsewhere(orgId, ids),
  ]);
  const rows = (data ?? []) as unknown as PublicPlayerRow[];
  return new Map(
    rows.map((r) => {
      const typed = masked.get(r.id);
      return [r.id, toPublicPlayer(typed === undefined ? r : { ...r, public_name: typed, photo_url: null, portrait_url: null })];
    }),
  );
}

/* ---------------- Entries ---------------- */

export async function listEntries(sessionId: string): Promise<FriendlyEntry[]> {
  const { data } = await db()
    .from("friendly_entries")
    .select("*")
    .eq("session_id", sessionId)
    .order("registered_at");
  return (data ?? []) as FriendlyEntry[];
}

export async function listApprovedEntries(sessionId: string): Promise<FriendlyEntry[]> {
  const { data } = await db()
    .from("friendly_entries")
    .select("*")
    .eq("session_id", sessionId)
    .eq("approval", "approved")
    .order("registered_at");
  return (data ?? []) as FriendlyEntry[];
}

/* ---------------- Pairs and participants ---------------- */

export async function listPairs(sessionId: string): Promise<FriendlyPair[]> {
  const { data } = await db()
    .from("friendly_pairs")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at");
  return (data ?? []) as FriendlyPair[];
}

/** Pairs that are live for a given round (not yet retired). */
export async function listActivePairs(
  sessionId: string,
  round: number
): Promise<FriendlyPair[]> {
  const pairs = await listPairs(sessionId);
  return pairs.filter(
    (p) => p.active_from_round <= round && (p.retired_after_round === null || p.retired_after_round >= round)
  );
}

export async function getMatchParticipants(
  matchId: string
): Promise<FriendlyMatchParticipants | null> {
  const { data } = await db()
    .from("friendly_match_participants")
    .select("*")
    .eq("match_id", matchId)
    .maybeSingle();
  return data as FriendlyMatchParticipants | null;
}

export async function listSessionParticipants(
  sessionId: string
): Promise<FriendlyMatchParticipants[]> {
  const { data } = await db()
    .from("friendly_match_participants")
    .select("*")
    .eq("session_id", sessionId);
  return (data ?? []) as FriendlyMatchParticipants[];
}

/* ---------------- Ledger ---------------- */

/**
 * Ledger rows for one player in authoritative order (ascending id).
 * This is the order fire replay MUST use — never a client timestamp.
 */
export async function listLedgerForPlayer(playerProfileId: string): Promise<LedgerRow[]> {
  const { data } = await db()
    .from("player_score_ledger")
    .select("*")
    .eq("player_profile_id", playerProfileId)
    .order("id", { ascending: true });
  return (data ?? []) as LedgerRow[];
}

export async function listLedgerForSession(sessionId: string): Promise<LedgerRow[]> {
  const { data } = await db()
    .from("player_score_ledger")
    .select("*")
    .eq("session_id", sessionId)
    .order("id", { ascending: true });
  return (data ?? []) as LedgerRow[];
}

export async function listLedgerForSeason(seasonId: string): Promise<LedgerRow[]> {
  const { data } = await db()
    .from("player_score_ledger")
    .select("*")
    .eq("season_id", seasonId)
    .order("id", { ascending: true });
  return (data ?? []) as LedgerRow[];
}

/* ---------------- Ranking snapshots ---------------- */

export async function getRankingSnapshot(
  scope: "session" | "season" | "lifetime",
  scopeId: string | null
): Promise<FriendlyRankingSnapshot[]> {
  let q = db().from("friendly_ranking_snapshots").select("*").eq("scope", scope);
  q = scopeId === null ? q.is("scope_id", null) : q.eq("scope_id", scopeId);
  const { data } = await q.order("rank");
  return (data ?? []) as FriendlyRankingSnapshot[];
}
