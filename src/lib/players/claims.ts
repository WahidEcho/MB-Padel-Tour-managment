/**
 * Player codes on the server: claiming a code, the linked player's profile,
 * resetting a code, and the player's own phone and photo.
 *
 * The link lives in player_claims (user_id, player_id), one account per player
 * (unique player_id). via_player_id records whose code made the link, so a reset
 * undoes exactly what that code linked. See src/lib/players/identity.ts for which
 * rows in other tournaments one claim links.
 */
import { randomInt, timingSafeEqual } from "crypto";
import { db, mediaPublicUrl } from "@/lib/supabase";
import { checkRateLimit } from "@/lib/ratelimit";
import { toMatch } from "@/lib/mobile/projection";
import { isDoneStatus, PLAYER_PHOTO, type MMyMatch, type MMyPlayer, type MMyPlayerEntry } from "@/lib/mobile/contract";
import { DEFAULT_FOCAL, sizedImageSrc } from "@/lib/portrait";
import { imageDimensions, sniffImageType } from "@/lib/upload";
import type { Match, MatchSnapshot } from "@/lib/types";
import { ACCESS_CODE_LENGTH, isValidAccessCode, newAccessCode, normalizeAccessCode } from "./accessCode";
import { linkedRows, normalizePersonName, type PersonKey } from "./identity";

export interface PlayerRow extends PersonKey {
  tournament_id: string;
  team_id: string;
  access_code: string | null;
  photo_url: string | null;
  portrait_url: string | null;
}

const PLAYER_COLUMNS = "id, tournament_id, team_id, full_name, player_profile_id, phone, email, access_code, photo_url, portrait_url";

/* ---------------- brute-force brake ---------------- */

// Only failed attempts count, so a venue full of players claiming over one Wi-Fi
// network is not throttled by its own successes.
const FAIL_LIMITS = { install: 8, user: 8, ip: 40 } as const;
const FAIL_WINDOW_SECONDS = 3600;

async function failuresSoFar(key: string): Promise<number> {
  const { data } = await db().from("request_counters").select("window_started_at, count").eq("bucket_key", key).maybeSingle();
  const row = data as { window_started_at: string; count: number } | null;
  if (!row) return 0;
  return (Date.now() - Date.parse(row.window_started_at)) / 1000 >= FAIL_WINDOW_SECONDS ? 0 : row.count;
}

export interface ClaimCaller {
  /** Null for a player-code sign-in, which has no account yet. */
  userId: string | null;
  installationId: string | null;
  ip: string;
}

const failKeys = (c: ClaimCaller) =>
  [
    c.userId ? [`pcode:u:${c.userId}`, FAIL_LIMITS.user] : null,
    c.installationId ? [`pcode:i:${c.installationId}`, FAIL_LIMITS.install] : null,
    [`pcode:ip:${c.ip}`, FAIL_LIMITS.ip],
  ].filter(Boolean) as [string, number][];

export async function claimBlocked(c: ClaimCaller): Promise<boolean> {
  const counts = await Promise.all(failKeys(c).map(async ([k, limit]) => (await failuresSoFar(k)) >= limit));
  return counts.some(Boolean);
}

async function recordFailure(c: ClaimCaller) {
  await Promise.all(failKeys(c).map(([key, limit]) => checkRateLimit({ key, limit, windowSeconds: FAIL_WINDOW_SECONDS })));
}

/* ---------------- claim ---------------- */

export type ClaimResult =
  | { ok: true; player: MMyPlayer; linked: number }
  | { ok: false; status: number; error: string };

export const GENERIC_CODE_ERROR = "That code didn't work. Check it and try again, or ask the tournament desk.";

// Compared in constant time once found, and against a dummy when not, so a miss
// and a near-miss cost the same.
const fixed = (s: string) => Buffer.from(s.padEnd(ACCESS_CODE_LENGTH, "#").slice(0, ACCESS_CODE_LENGTH));
function sameCode(stored: string | null, typed: string): boolean {
  const equal = timingSafeEqual(fixed(stored ?? "########"), fixed(typed));
  return equal && stored !== null && stored === typed;
}

export type FoundPlayer = { ok: true; row: PlayerRow } | { ok: false; status: number; error: string };

/**
 * The player whose code this is, or the generic refusal (a failure counts towards
 * the caller's brake). Looked up by the code, then compared in constant time.
 */
export async function findPlayerByCode(caller: ClaimCaller, rawCode: string): Promise<FoundPlayer> {
  const code = normalizeAccessCode(rawCode);
  let row: PlayerRow | null = null;
  if (isValidAccessCode(code)) {
    const { data } = await db().from("players").select(PLAYER_COLUMNS).eq("access_code", code).maybeSingle();
    row = (data as PlayerRow | null) ?? null;
  }
  if (!sameCode(row?.access_code ?? null, code) || !row) {
    await recordFailure(caller);
    return { ok: false, status: 400, error: GENERIC_CODE_ERROR };
  }
  return { ok: true, row };
}

/** The account a player is linked to, or null. */
export async function playerHolder(playerId: string): Promise<string | null> {
  const { data } = await db().from("player_claims").select("user_id").eq("player_id", playerId).maybeSingle();
  return (data as { user_id: string } | null)?.user_id ?? null;
}

/**
 * Lets an account go of every player it holds, keeping the players' photos (the
 * player carries on with another account). Used when a player signs in with their
 * code on a new phone before they registered: the link moves to the new account.
 */
export async function releaseClaims(userId: string): Promise<void> {
  await db().from("player_claims").delete().eq("user_id", userId);
}

export async function claimPlayerCode(caller: ClaimCaller & { userId: string }, rawCode: string): Promise<ClaimResult> {
  const found = await findPlayerByCode(caller, rawCode);
  if (!found.ok) return found;
  return linkPlayer(caller.userId, found.row);
}

/** Links an account to the player (and the same person in other tournaments): what a claim does once the code is right. */
export async function linkPlayer(userId: string, row: PlayerRow): Promise<ClaimResult> {
  const caller = { userId };
  // One account per player.
  const { data: holder } = await db().from("player_claims").select("user_id").eq("player_id", row.id).maybeSingle();
  const heldBy = (holder as { user_id: string } | null)?.user_id ?? null;
  if (heldBy && heldBy !== caller.userId) {
    return { ok: false, status: 409, error: "This code is already linked to another account. Ask the tournament desk to reset it." };
  }

  // One person per account: a second code must be the same person.
  const current = await claimedRows(caller.userId);
  if (current.length && !current.some((p) => normalizePersonName(p.full_name) === normalizePersonName(row!.full_name))) {
    return { ok: false, status: 409, error: `This account is linked to ${current[0]!.full_name}. Unlink that player in Account first.` };
  }

  if (!heldBy) {
    // A plain insert: if another account took the player a moment ago, the unique key refuses this one.
    const { error } = await db().from("player_claims").insert({ user_id: caller.userId, player_id: row.id, via_player_id: row.id });
    if (error) return { ok: false, status: 409, error: "This code is already linked to another account. Ask the tournament desk to reset it." };
  }

  // The same person in other tournaments, where it is safe to say so.
  const siblings = await siblingRows(row);
  const free = await unclaimed(siblings.map((s) => s.id));
  if (free.length) {
    await db()
      .from("player_claims")
      .insert(free.map((id) => ({ user_id: caller.userId, player_id: id, via_player_id: row!.id })));
  }
  const player = await loadMyPlayer(caller.userId);
  return { ok: true, player: player!, linked: 1 + free.length };
}

async function siblingRows(row: PlayerRow): Promise<PlayerRow[]> {
  const queries = [];
  if (row.player_profile_id) queries.push(db().from("players").select(PLAYER_COLUMNS).eq("player_profile_id", row.player_profile_id));
  if (row.phone) queries.push(db().from("players").select(PLAYER_COLUMNS).eq("phone", row.phone));
  if (row.email) queries.push(db().from("players").select(PLAYER_COLUMNS).eq("email", row.email.toLowerCase()));
  const found = new Map<string, PlayerRow>();
  for (const r of await Promise.all(queries)) for (const p of (r.data ?? []) as PlayerRow[]) found.set(p.id, p);
  return linkedRows(row, [...found.values()]);
}

async function unclaimed(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { data } = await db().from("player_claims").select("player_id").in("player_id", ids);
  const taken = new Set(((data ?? []) as { player_id: string }[]).map((r) => r.player_id));
  return ids.filter((id) => !taken.has(id));
}

async function claimedRows(userId: string): Promise<(PlayerRow & { via_player_id: string | null; claimed_at: string })[]> {
  const { data: claims } = await db().from("player_claims").select("player_id, via_player_id, created_at").eq("user_id", userId);
  const list = (claims ?? []) as { player_id: string; via_player_id: string | null; created_at: string }[];
  if (!list.length) return [];
  const { data } = await db().from("players").select(PLAYER_COLUMNS).in("id", list.map((c) => c.player_id));
  const byId = new Map(((data ?? []) as PlayerRow[]).map((p) => [p.id, p]));
  return list
    .filter((c) => byId.has(c.player_id))
    .map((c) => ({ ...byId.get(c.player_id)!, via_player_id: c.via_player_id, claimed_at: c.created_at }));
}

/* ---------------- the linked player ---------------- */

interface TeamRow {
  id: string;
  team_name: string;
  nation_code: string | null;
  iso2: string | null;
}
interface TournamentRow {
  id: string;
  slug: string;
  name: string;
  sport: string | null;
  timezone: string | null;
  starts_on: string | null;
  created_at: string | null;
}

const SNAPSHOT_COLUMNS =
  "match_id, current_set_number, team_a_point_label, team_b_point_label, team_a_games, team_b_games, team_a_sets, team_b_sets, is_tiebreak, tiebreak_team_a_points, tiebreak_team_b_points, serving_team_id, last_event_number, last_undo_event_number, completed_sets, snapshot_json, updated_at";

const photoOf = (p: Pick<PlayerRow, "photo_url" | "portrait_url">) => sizedImageSrc(p.photo_url || p.portrait_url, 512);

export async function loadMyPlayer(userId: string): Promise<MMyPlayer | null> {
  const rows = await claimedRows(userId);
  if (!rows.length) return null;
  const [{ data: teams }, { data: tours }] = await Promise.all([
    db().from("teams").select("id, team_name, nation_code, iso2").in("id", [...new Set(rows.map((r) => r.team_id))]),
    db().from("tournaments").select("id, slug, name, sport, timezone, starts_on, created_at").in("id", [...new Set(rows.map((r) => r.tournament_id))]),
  ]);
  const teamOf = new Map(((teams ?? []) as TeamRow[]).map((t) => [t.id, t]));
  const tourOf = new Map(((tours ?? []) as TournamentRow[]).map((t) => [t.id, t]));
  const when = (tid: string) => tourOf.get(tid)?.starts_on ?? tourOf.get(tid)?.created_at ?? "";
  rows.sort((a, b) => when(b.tournament_id).localeCompare(when(a.tournament_id)));
  // The row whose own code was entered, most recent claim first.
  const primary = [...rows].filter((r) => r.via_player_id === r.id).sort((a, b) => b.claimed_at.localeCompare(a.claimed_at))[0] ?? rows[0]!;
  const entries: MMyPlayerEntry[] = rows
    .filter((r) => tourOf.has(r.tournament_id))
    .map((r) => {
      const tm = teamOf.get(r.team_id);
      const tr = tourOf.get(r.tournament_id)!;
      return {
        playerId: r.id,
        tournamentId: tr.id,
        tournamentSlug: tr.slug,
        tournamentName: tr.name,
        sport: tr.sport ?? "padel",
        timezone: tr.timezone ?? "Africa/Cairo",
        teamId: r.team_id,
        teamName: tm?.team_name ?? "",
        nationCode: tm?.nation_code ?? null,
        iso2: tm?.iso2 ?? null,
      };
    });
  const primaryTeam = teamOf.get(primary.team_id);
  const withPhoto = rows.find((r) => r.photo_url || r.portrait_url);
  return {
    playerId: primary.id,
    name: primary.full_name,
    nationCode: primaryTeam?.nation_code ?? null,
    iso2: primaryTeam?.iso2 ?? null,
    teamName: primaryTeam?.team_name ?? "",
    phone: primary.phone ?? rows.find((r) => r.phone)?.phone ?? null,
    photoUrl: withPhoto ? photoOf(withPhoto) : null,
    entries,
    matches: await myMatches(rows, teamOf, tourOf),
  };
}

async function myMatches(rows: PlayerRow[], teamOf: Map<string, TeamRow>, tourOf: Map<string, TournamentRow>): Promise<MMyMatch[]> {
  const teamIds = [...new Set(rows.map((r) => r.team_id))];
  const playerIds = new Set(rows.map((r) => r.id));
  const [{ data: a }, { data: b }] = await Promise.all([
    db().from("matches").select("*").in("team_a_id", teamIds),
    db().from("matches").select("*").in("team_b_id", teamIds),
  ]);
  const all = new Map<string, Match>();
  for (const m of [...((a ?? []) as Match[]), ...((b ?? []) as Match[])]) all.set(m.id, m);
  // In a team tie only the rubbers the player was nominated for; elsewhere every match of the team.
  const mine = [...all.values()].filter((m) => {
    if (m.status === "cancelled") return false;
    if (!m.tie_id) return true;
    const nominees = [...((m.team_a_player_ids as string[] | null) ?? []), ...((m.team_b_player_ids as string[] | null) ?? [])];
    return nominees.length === 0 || nominees.some((n) => playerIds.has(n));
  });
  if (!mine.length) return [];
  const { data: snaps } = await db().from("match_score_snapshots").select(SNAPSHOT_COLUMNS).in("match_id", mine.map((m) => m.id));
  const snapOf = new Map(((snaps ?? []) as unknown as MatchSnapshot[]).map((s) => [s.match_id, s]));
  const others = [...new Set(mine.flatMap((m) => [m.team_a_id, m.team_b_id]).filter((id): id is string => Boolean(id) && !teamOf.has(id!)))];
  if (others.length) {
    const { data } = await db().from("teams").select("id, team_name, nation_code, iso2").in("id", others);
    for (const t of (data ?? []) as TeamRow[]) teamOf.set(t.id, t);
  }
  const myTeams = new Set(teamIds);
  const out: MMyMatch[] = mine
    .filter((m) => tourOf.has(m.tournament_id))
    .map((m) => ({
      ...toMatch(m, snapOf.get(m.id) ?? null),
      tournamentSlug: tourOf.get(m.tournament_id)!.slug,
      tournamentName: tourOf.get(m.tournament_id)!.name,
      aName: m.team_a_id ? (teamOf.get(m.team_a_id)?.team_name ?? null) : null,
      bName: m.team_b_id ? (teamOf.get(m.team_b_id)?.team_name ?? null) : null,
      mySide: m.team_a_id && myTeams.has(m.team_a_id) ? "A" : m.team_b_id && myTeams.has(m.team_b_id) ? "B" : null,
    }));
  // Still to play (soonest first), then results (latest first).
  const done = (m: MMyMatch) => isDoneStatus(m.status);
  return [
    ...out.filter((m) => !done(m)).sort((x, y) => (x.scheduledTime ?? "9").localeCompare(y.scheduledTime ?? "9") || x.order - y.order),
    ...out.filter(done).sort((x, y) => (y.endedAt ?? y.scheduledTime ?? "").localeCompare(x.endedAt ?? x.scheduledTime ?? "")),
  ];
}

/* ---------------- the player's own changes ---------------- */

async function myPlayerIds(userId: string): Promise<string[]> {
  const { data } = await db().from("player_claims").select("player_id").eq("user_id", userId);
  return ((data ?? []) as { player_id: string }[]).map((r) => r.player_id);
}

/** Sets the phone on every linked row. `e164` is already validated, or null to clear it. */
export async function setMyPhone(userId: string, e164: string | null): Promise<boolean> {
  const ids = await myPlayerIds(userId);
  if (!ids.length) return false;
  const { error } = await db().from("players").update({ phone: e164, updated_at: new Date().toISOString() }).in("id", ids);
  if (error) throw new Error(error.message);
  return true;
}

export type PhotoCheck = { ok: true; bytes: Uint8Array; type: string } | { ok: false; error: string };

/** Base64 from the app, checked by its real bytes, not its claimed type. */
export function checkPhoto(base64: unknown): PhotoCheck {
  if (typeof base64 !== "string" || !base64) return { ok: false, error: "No photo was sent." };
  const clean = base64.replace(/^data:[^;]+;base64,/, "");
  if (clean.length > Math.ceil((PLAYER_PHOTO.maxBytes * 4) / 3) + 8) return { ok: false, error: "That photo is too large. Pick a smaller one." };
  const bytes = new Uint8Array(Buffer.from(clean, "base64"));
  if (!bytes.length) return { ok: false, error: "No photo was sent." };
  if (bytes.length > PLAYER_PHOTO.maxBytes) return { ok: false, error: "That photo is too large. Pick a smaller one." };
  const type = sniffImageType(bytes.slice(0, 16));
  if (!type || !(PLAYER_PHOTO.types as readonly string[]).includes(type)) return { ok: false, error: "That file is not a JPEG, PNG or WebP photo." };
  const dims = imageDimensions(bytes, type);
  if (dims && (dims.width > PLAYER_PHOTO.maxSide || dims.height > PLAYER_PHOTO.maxSide)) return { ok: false, error: "That photo is too large. Pick a smaller one." };
  return { ok: true, bytes, type };
}

const SELF_PREFIX = "players/self/";
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * Stores the player's photo in the public media bucket through the server's own
 * client (the app never holds a storage key) and sets it on every linked row.
 * The player's photo replaces the organiser's: the cut-out and framing reset.
 */
export async function setMyPhoto(userId: string, photo: { bytes: Uint8Array; type: string }): Promise<string | null> {
  const ids = await myPlayerIds(userId);
  if (!ids.length) return null;
  const { data: before } = await db().from("players").select("photo_url").in("id", ids);
  const path = `${SELF_PREFIX}${ids[0]}/${Date.now()}-${randomInt(1e9).toString(36)}.${EXT[photo.type] ?? "jpg"}`;
  const { error: upErr } = await db().storage.from("media").upload(path, photo.bytes, { contentType: photo.type, upsert: false, cacheControl: "31536000" });
  if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
  const url = mediaPublicUrl(path);
  const { error } = await db()
    .from("players")
    .update({ photo_url: url, portrait_url: null, focal_x: DEFAULT_FOCAL[0], focal_y: DEFAULT_FOCAL[1], updated_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(error.message);
  await removeSelfPhotos(((before ?? []) as { photo_url: string | null }[]).map((r) => r.photo_url));
  return url;
}

/** Deletes the player's own earlier uploads (never an organiser's photo, which clones may share). */
export async function removeSelfPhotos(urls: (string | null)[]) {
  const prefix = mediaPublicUrl(SELF_PREFIX);
  const paths = [...new Set(urls.filter((u): u is string => Boolean(u) && u!.startsWith(prefix)))].map((u) => u.slice(mediaPublicUrl("").length));
  if (paths.length) await db().storage.from("media").remove(paths);
}

/** "This isn't me" / account deletion: the account lets go of its players; a photo the player uploaded goes too. */
export async function unlinkMe(userId: string): Promise<number> {
  const ids = await myPlayerIds(userId);
  if (!ids.length) return 0;
  const { data } = await db().from("players").select("id, photo_url").in("id", ids);
  const own = ((data ?? []) as { id: string; photo_url: string | null }[]).filter((r) => r.photo_url?.startsWith(mediaPublicUrl(SELF_PREFIX)));
  if (own.length) {
    await db().from("players").update({ photo_url: null }).in("id", own.map((r) => r.id));
    await removeSelfPhotos(own.map((r) => r.photo_url));
  }
  await db().from("player_claims").delete().eq("user_id", userId);
  return ids.length;
}

/* ---------------- admin ---------------- */

/**
 * A new code for one player. The old code stops working at once, and the
 * account it linked lets go of this player and of every row that code linked.
 */
export async function resetPlayerCode(playerId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newAccessCode(randomInt);
    const { error } = await db().from("players").update({ access_code: code, updated_at: new Date().toISOString() }).eq("id", playerId);
    if (!error) {
      await db().from("player_claims").delete().eq("player_id", playerId);
      await db().from("player_claims").delete().eq("via_player_id", playerId);
      return code;
    }
    if (!/duplicate|unique|23505/i.test(error.message)) throw new Error(error.message);
  }
  throw new Error("Could not make a unique code. Try again.");
}

/** Codes for players created before codes existed (or whose code was cleared by hand). */
export async function fillMissingCodes(tournamentId: string): Promise<number> {
  const { data } = await db().from("players").select("id").eq("tournament_id", tournamentId).is("access_code", null);
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  for (const id of ids) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { error } = await db().from("players").update({ access_code: newAccessCode(randomInt) }).eq("id", id).is("access_code", null);
      if (!error) break;
    }
  }
  return ids.length;
}
