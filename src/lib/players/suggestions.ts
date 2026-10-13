/**
 * "Is this you?" after signing in (Phase 1). Server-only.
 *
 *  - email match: entries an organiser recorded with the account's own confirmed
 *    email (the entry's email, or its profile's), one suggestion per person;
 *  - organiser offers: an organisation's "Link to app account" for one of its
 *    players, made out to this account's email (player_link_offers).
 *
 * Nothing links until the player confirms. A suggestion's id is signed and bound to
 * the account and the rows it names, so it cannot be replayed by another account
 * or stretched to other rows; the rows are checked again when it is confirmed.
 * Anonymous (player-code) accounts and unconfirmed emails get no suggestions.
 */
import { createHmac } from "node:crypto";
import { db } from "../supabase";
import { checkRateLimit } from "../ratelimit";
import { safeEqual } from "../auth/safeEqual";
import { getAuthUser } from "../auth/accounts";
import { normalizeEmail } from "../messaging/email";
import { contactHash, playerCodePepper } from "./codeVault";
import { loadMyPlayer, PLAYER_COLUMNS, type PlayerRow } from "./claims";
import { samePerson } from "./identity";
import { accountProfile, linkAccount, orgsOfTournaments } from "./link";
import type { MLinkSuggestion, MMyPlayer } from "../mobile/contract";

export type AnswerResult = { ok: true; player: MMyPlayer | null; linked: number } | { ok: true; declined: true } | { ok: false; status: number; error: string };

const TTL_MS = 30 * 60_000;

type Token = { u: string; k: "email" | "offer"; r: string[]; o?: string; x: number };

function sign(t: Token): string {
  // At most 50 rows per suggestion keeps the id small (the confirm body is capped).
  const body = Buffer.from(JSON.stringify({ ...t, r: t.r.slice(0, 50) })).toString("base64url");
  const sig = createHmac("sha256", playerCodePepper()).update(`mb-link-suggestion:v1:${body}`).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token: unknown, userId: string): Token | null {
  if (typeof token !== "string" || token.length > 4000) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", playerCodePepper()).update(`mb-link-suggestion:v1:${body}`).digest("base64url");
  if (!safeEqual(sig, want)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Token;
    if (t.u !== userId || t.x < Date.now() || !Array.isArray(t.r)) return null;
    return t;
  } catch {
    return null;
  }
}

/** The account's confirmed email, straight from Supabase Auth, or null. */
export async function confirmedEmail(accessToken: string): Promise<string | null> {
  const u = await getAuthUser(accessToken);
  if (!u.ok || u.data.is_anonymous || !u.data.email || !u.data.email_confirmed_at) return null;
  return normalizeEmail(u.data.email);
}

/**
 * A case-insensitive equality filter for an address: LIKE wildcards escaped, and the
 * caller re-checks every row exactly (an address with "*", PostgREST's wildcard, is
 * matched exactly only).
 */
const likeExact = (email: string) => (email.includes("*") ? null : email.replace(/[\\%_]/g, (c) => `\\${c}`));
const sameEmail = (a: string | null | undefined, email: string) => (a ?? "").trim().toLowerCase() === email;

async function rowsForEmail(userId: string, email: string): Promise<PlayerRow[]> {
  const pattern = likeExact(email);
  const profQ = db().from("player_profiles").select("id, email").neq("approval_status", "merged").limit(5);
  const { data: profs } = await (pattern ? profQ.ilike("email", pattern) : profQ.eq("email", email));
  const profileIds = ((profs ?? []) as { id: string; email: string | null }[]).filter((p) => sameEmail(p.email, email)).map((p) => p.id);
  const rowQ = db().from("players").select(PLAYER_COLUMNS).limit(200);
  const [{ data: byEmail }, { data: byProfile }] = await Promise.all([
    pattern ? rowQ.ilike("email", pattern) : rowQ.eq("email", email),
    profileIds.length ? db().from("players").select(PLAYER_COLUMNS).in("player_profile_id", profileIds).limit(200) : Promise.resolve({ data: [] }),
  ]);
  const rows = new Map<string, PlayerRow>();
  for (const r of ((byEmail ?? []) as PlayerRow[]).filter((r) => sameEmail(r.email, email))) rows.set(r.id, r);
  for (const r of (byProfile ?? []) as PlayerRow[]) rows.set(r.id, r);
  if (!rows.size) return [];
  const { data: held } = await db().from("player_claims").select("player_id").in("player_id", [...rows.keys()]);
  for (const h of (held ?? []) as { player_id: string }[]) rows.delete(h.player_id); // already linked (to this account or another)
  return [...rows.values()];
}

function group(rows: PlayerRow[], email: string): PlayerRow[][] {
  const keyed = (r: PlayerRow) => ({ ...r, email: r.email ?? email });
  const groups: PlayerRow[][] = [];
  for (const r of rows) {
    const g = groups.find((x) => x.some((y) => samePerson(keyed(y), keyed(r))));
    if (g) g.push(r);
    else groups.push([r]);
  }
  return groups;
}

async function tournamentNames(rows: PlayerRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.tournament_id))];
  if (!ids.length) return new Map();
  const { data } = await db().from("tournaments").select("id, name").in("id", ids);
  return new Map(((data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
}

export type SuggestionsResult = { ok: true; suggestions: MLinkSuggestion[] } | { ok: false; status: number; error: string };

/** GET /me/player/suggestions. */
export async function linkSuggestions(userId: string, accessToken: string, ip: string): Promise<SuggestionsResult> {
  if (!(await checkRateLimit({ key: `sugg:u:${userId}`, limit: 30, windowSeconds: 600 })).allowed || !(await checkRateLimit({ key: `sugg:ip:${ip}`, limit: 120, windowSeconds: 600 })).allowed) {
    return { ok: false, status: 429, error: "Too many tries. Wait a few minutes and try again." };
  }
  const email = await confirmedEmail(accessToken);
  if (!email) return { ok: true, suggestions: [] };
  const out: MLinkSuggestion[] = [];
  const x = Date.now() + TTL_MS;

  const rows = await rowsForEmail(userId, email);
  const names = await tournamentNames(rows);
  for (const g of group(rows, email).slice(0, 5)) {
    out.push({ id: sign({ u: userId, k: "email", r: g.map((r) => r.id), x }), kind: "email", name: g[0]!.full_name, organization: null, entries: [...new Set(g.map((r) => names.get(r.tournament_id)).filter((n): n is string => Boolean(n)))].slice(0, 6) });
  }

  const mine = await accountProfile(userId);
  const { data: offers } = await db()
    .from("player_link_offers")
    .select("id, organization_id, player_profile_id, expires_at")
    .eq("email_hash", contactHash("email", email))
    .is("consumed_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .limit(5);
  for (const o of (offers ?? []) as { id: string; organization_id: string; player_profile_id: string }[]) {
    if (mine && mine.id !== o.player_profile_id) continue; // already someone else: the desk sorts it out
    const [{ data: prof }, { data: org }, offerRows] = await Promise.all([
      db().from("player_profiles").select("public_name, auth_user_id").eq("id", o.player_profile_id).maybeSingle(),
      db().from("organizations").select("name").eq("id", o.organization_id).maybeSingle(),
      offerRowsOf(o.organization_id, o.player_profile_id),
    ]);
    const p = prof as { public_name: string; auth_user_id: string | null } | null;
    if (!p || (p.auth_user_id && p.auth_user_id !== userId)) continue;
    const on = await tournamentNames(offerRows);
    out.push({
      id: sign({ u: userId, k: "offer", r: offerRows.map((r) => r.id), o: o.id, x }),
      kind: "offer",
      name: p.public_name,
      organization: (org as { name: string } | null)?.name ?? null,
      entries: [...new Set(offerRows.map((r) => on.get(r.tournament_id)).filter((n): n is string => Boolean(n)))].slice(0, 6),
    });
  }
  return { ok: true, suggestions: out };
}

/** The organisation's rows of a profile that nobody holds yet. */
async function offerRowsOf(orgId: string, profileId: string): Promise<PlayerRow[]> {
  const { data } = await db().from("players").select(PLAYER_COLUMNS).eq("player_profile_id", profileId).limit(200);
  const rows = (data ?? []) as PlayerRow[];
  if (!rows.length) return [];
  const orgOf = await orgsOfTournaments(rows.map((r) => r.tournament_id));
  const own = rows.filter((r) => orgOf.get(r.tournament_id) === orgId);
  if (!own.length) return [];
  const { data: held } = await db().from("player_claims").select("player_id").in("player_id", own.map((r) => r.id));
  const taken = new Set(((held ?? []) as { player_id: string }[]).map((h) => h.player_id));
  return own.filter((r) => !taken.has(r.id));
}

const GONE = "That suggestion has expired. Pull to refresh and try again.";

/** POST /me/player/suggestions { id, accept }: "That's me" links; "Not me" for an offer withdraws it. */
export async function answerSuggestion(userId: string, accessToken: string, id: unknown, accept: boolean): Promise<AnswerResult> {
  if (!(await checkRateLimit({ key: `sugg:a:${userId}`, limit: 20, windowSeconds: 600 })).allowed) return { ok: false, status: 429, error: "Too many tries. Wait a few minutes and try again." };
  const t = verify(id, userId);
  if (!t) return { ok: false, status: 410, error: GONE };
  const email = await confirmedEmail(accessToken);
  if (!email) return { ok: false, status: 410, error: GONE };
  if (t.k === "offer") {
    const { data } = await db().from("player_link_offers").select("id, organization_id, player_profile_id, email_hash, expires_at, consumed_at, revoked_at").eq("id", t.o ?? "").maybeSingle();
    const o = data as { id: string; organization_id: string; player_profile_id: string; email_hash: string; expires_at: string; consumed_at: string | null; revoked_at: string | null } | null;
    if (!o || o.consumed_at || o.revoked_at || Date.parse(o.expires_at) < Date.now() || !safeEqual(o.email_hash, contactHash("email", email))) return { ok: false, status: 410, error: GONE };
    if (!accept) {
      await db().from("player_link_offers").update({ revoked_at: new Date().toISOString() }).eq("id", o.id).is("consumed_at", null);
      return { ok: true, declined: true };
    }
    const rows = (await offerRowsOf(o.organization_id, o.player_profile_id)).filter((r) => t.r.includes(r.id));
    const r = await linkAccount(userId, rows.length ? rows : [], { kind: "offer", orgId: o.organization_id, profileId: o.player_profile_id });
    if (!r.ok && r.status === 404 && !rows.length) return linkProfileOnly(userId, o);
    if (r.ok) await db().from("player_link_offers").update({ consumed_at: new Date().toISOString(), consumed_by: userId }).eq("id", o.id).is("consumed_at", null);
    return r;
  }
  if (!accept) return { ok: true, declined: true };
  const current = new Map((await rowsForEmail(userId, email)).map((r) => [r.id, r]));
  const rows = t.r.map((rid) => current.get(rid)).filter((r): r is PlayerRow => Boolean(r));
  if (!rows.length) return { ok: false, status: 410, error: GONE };
  return linkAccount(userId, rows, { kind: "email", email });
}

/** An offer for a profile with no tournament rows (sessions only): the account speaks for the profile. */
async function linkProfileOnly(userId: string, o: { id: string; player_profile_id: string }): Promise<AnswerResult> {
  const mine = await accountProfile(userId);
  if (mine && mine.id !== o.player_profile_id) return { ok: false, status: 409, error: "Your account is already linked to another player profile. Ask the tournament desk for help." };
  const { data } = await db().from("player_profiles").update({ auth_user_id: userId, updated_at: new Date().toISOString() }).eq("id", o.player_profile_id).is("auth_user_id", null).select("id");
  if (!data?.length && !mine) return { ok: false, status: 409, error: "This player is linked to another Move Score account. Ask the tournament desk for help." };
  await db().from("player_link_offers").update({ consumed_at: new Date().toISOString(), consumed_by: userId }).eq("id", o.id).is("consumed_at", null);
  return { ok: true, player: await loadMyPlayer(userId), linked: 0 };
}
