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

export async function listSessions(seasonId?: string): Promise<FriendlySession[]> {
  let q = db().from("friendly_sessions").select("*");
  if (seasonId) q = q.eq("season_id", seasonId);
  const { data } = await q.order("starts_at", { ascending: false, nullsFirst: false });
  return (data ?? []) as FriendlySession[];
}

/* ---------------- Seasons and categories ---------------- */

export async function listSeasons(): Promise<Season[]> {
  const { data } = await db()
    .from("seasons")
    .select("*")
    .order("starts_on", { ascending: false, nullsFirst: false });
  return (data ?? []) as Season[];
}

export async function getActiveSeason(): Promise<Season | null> {
  const { data } = await db()
    .from("seasons")
    .select("*")
    .eq("status", "active")
    .maybeSingle();
  return data as Season | null;
}

export async function listRankingCategories(): Promise<RankingCategory[]> {
  const { data } = await db()
    .from("ranking_categories")
    .select("*")
    .order("sort_order")
    .order("name");
  return (data ?? []) as RankingCategory[];
}

/* ---------------- Player profiles ---------------- */

/**
 * Admin-only: includes the mobile number.
 * Never pass the result of this to a public page — use `listPublicPlayers`
 * or `toPublicPlayer` instead.
 */
export async function listPlayerProfiles(search?: string): Promise<PlayerProfile[]> {
  let q = db().from("player_profiles").select("*").is("merged_into_profile_id", null);
  if (search && search.trim()) {
    q = q.ilike("public_name", `%${search.trim()}%`);
  }
  const { data } = await q.order("public_name");
  return (data ?? []) as PlayerProfile[];
}

export async function getPlayerProfile(id: string): Promise<PlayerProfile | null> {
  const { data } = await db().from("player_profiles").select("*").eq("id", id).maybeSingle();
  return data as PlayerProfile | null;
}

/** Find an existing profile by canonical mobile. Admin/server use only. */
export async function findProfileByMobile(
  mobileNormalized: string
): Promise<PlayerProfile | null> {
  const { data } = await db()
    .from("player_profiles")
    .select("*")
    .eq("mobile_normalized", mobileNormalized)
    .maybeSingle();
  return data as PlayerProfile | null;
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

/** Public-safe lookup for a set of profile ids: names and faces, nothing else. */
export async function listPublicPlayers(ids: string[]): Promise<Map<string, PublicPlayer>> {
  if (ids.length === 0) return new Map();
  const { data } = await db()
    .from("player_profiles")
    .select(PUBLIC_PLAYER_COLUMNS)
    .in("id", ids);
  const rows = (data ?? []) as unknown as PublicPlayerRow[];
  return new Map(rows.map((r) => [r.id, toPublicPlayer(r)]));
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
