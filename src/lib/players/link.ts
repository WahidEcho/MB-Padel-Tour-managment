/**
 * Linking a Move Score account to a person's player history (Phase 1).
 *
 * One person = one player_profiles row with auth_user_id = their account. The
 * account sees and edits the per-tournament `players` rows it holds in
 * player_claims (one account per row). What a way in proves decides what it links:
 *
 *  - code   the row whose code it is, and the same person's rows in the SAME
 *           organisation's tournaments (identity.ts). An organisation can type any
 *           name, phone or email on its own rows, so nothing it writes may pull in
 *           another organisation's rows.
 *  - phone  (a one-time code reached the phone) rows recorded with that phone, or
 *           whose profile has that mobile, in any organisation; the player picks
 *           which person they are when several share the phone.
 *  - email  (the account's confirmed email, and the player said "that's me") rows
 *           recorded with that email, or whose profile has it.
 *  - offer  an organiser's "Link to app account" for one of its own players, which
 *           the player confirmed: that organisation's rows of the profile.
 *  - profile rows of the account's own profile in organisations that vouch for it
 *           (any relation but 'matched', or a share the player confirmed), picked
 *           up again whenever the profile is read (syncProfileClaims).
 *
 * The profile: the account's own if it has one; else the row's profile when the
 * proof reaches it (a code from an organisation that vouches for the profile; a
 * phone or email that is the profile's own, or, when the profile has none, a row of
 * an organisation that vouches for it; an organiser's offer from an organisation
 * that added the player); else, when the rows have no profile at all, a new profile
 * made from the row (name, phone in E.164, email). Rows on a profile the proof does
 * not reach are linked without it. A new profile never takes over an existing
 * profile's mobile number: only a phone code proves that. Rows without a profile
 * join the account's profile.
 *
 * Offers: an account that came to speak for a profile through one organisation's
 * offer has only that organisation's word (player_profiles.owner_scope_org): the
 * profile's rows in other organisations are not picked up for it, and its sessions
 * elsewhere are not shown, until a phone code to the profile's own mobile, or the
 * profile's own email, lands on it.
 *
 * Organisations: an organisation whose row joined an existing profile gets the
 * player as 'matched' (it sees the name it typed, not the person's contact fields)
 * until the player shares their details with it in the app ('link', shareWithOrg).
 * A profile made from an organisation's own row is that organisation's ('tournament').
 *
 * Server-only.
 */
import { db } from "../supabase";
import { normalizeMobile } from "../friendly/mobile";
import { ensureOrgPlayer } from "../orgs/scope";
import { personFieldsVisibleFor } from "../orgs/personFields";
import { linkedRows, normalizePersonName } from "./identity";
import { toE164 } from "./phone";
import {
  claimedRows,
  findPlayerByCode,
  loadMyPlayer,
  PLAYER_COLUMNS,
  type ClaimCaller,
  type ClaimResult,
  type PlayerRow,
} from "./claims";

export type LinkProof =
  | { kind: "code"; row: PlayerRow }
  | { kind: "phone"; phone: string }
  | { kind: "email"; email: string }
  | { kind: "offer"; orgId: string; profileId: string };

export const CODE_TAKEN = "This code is already linked to another account. Ask the tournament desk to reset it.";
export const PROFILE_TAKEN = "This player is linked to another Move Score account. Ask the tournament desk for help.";
export const NOTHING_TO_LINK = "We couldn't find those entries any more.";

/* ---------------- small reads ---------------- */

/** tournament id → organisation id. */
export async function orgsOfTournaments(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(ids)];
  for (let i = 0; i < wanted.length; i += 200) {
    const { data } = await db().from("tournaments").select("id, organization_id").in("id", wanted.slice(i, i + 200));
    for (const t of (data ?? []) as { id: string; organization_id: string | null }[]) if (t.organization_id) out.set(t.id, t.organization_id);
  }
  return out;
}

interface ProfileRow {
  id: string;
  public_name: string;
  mobile_normalized: string | null;
  email: string | null;
  auth_user_id: string | null;
  approval_status: string;
  owner_scope_org: string | null;
}
const PROFILE_COLUMNS = "id, public_name, mobile_normalized, email, auth_user_id, approval_status, owner_scope_org";

const sameEmail = (a: string | null | undefined, email: string) => (a ?? "").trim().toLowerCase() === email;

/** The profile this account speaks for, if any. */
export async function accountProfile(userId: string): Promise<ProfileRow | null> {
  const { data } = await db().from("player_profiles").select(PROFILE_COLUMNS).eq("auth_user_id", userId).maybeSingle();
  return (data as ProfileRow | null) ?? null;
}

async function profilesById(ids: string[]): Promise<ProfileRow[]> {
  if (!ids.length) return [];
  const { data } = await db().from("player_profiles").select(PROFILE_COLUMNS).in("id", ids);
  return ((data ?? []) as ProfileRow[]).filter((p) => p.approval_status !== "merged");
}

/**
 * Whether an organisation vouches for its link to a profile: it created or added
 * the player, or no other organisation has them (the person-fields rule). An
 * organisation that only matched an existing profile by a typed mobile does not.
 */
export async function orgVouchesFor(orgId: string | null | undefined, profileId: string): Promise<boolean> {
  const { data } = await db().from("organization_players").select("organization_id, source").eq("player_profile_id", profileId);
  const rows = (data ?? []) as { organization_id: string; source: string }[];
  const mine = rows.find((r) => r.organization_id === orgId);
  const others = rows.filter((r) => r.organization_id !== orgId).length;
  if (!mine) return others === 0;
  return personFieldsVisibleFor(mine.source, others);
}

async function holdersOf(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db().from("player_claims").select("player_id, user_id").in("player_id", ids.slice(i, i + 200));
    for (const r of (data ?? []) as { player_id: string; user_id: string }[]) out.set(r.player_id, r.user_id);
  }
  return out;
}

/** A row's phone as a profile mobile: E.164 when it is a usable number, else the friendly sessions' normal form. */
export function profileMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return toE164(raw) ?? normalizeMobile(raw) ?? null;
}

/**
 * A profile made from a row the account proved. Never takes another profile's mobile
 * number. Its mobile: the number a phone code proved; for a code, the number the
 * code's organisation recorded on the row; for an email proof, none (the row's phone
 * is exactly what an email does not prove).
 */
async function createProfileFrom(row: PlayerRow, mobileHint: string | null, rowPhone: boolean): Promise<string> {
  const mobile = mobileHint ?? (rowPhone ? profileMobile(row.phone) : null);
  let mobileFree = Boolean(mobile);
  if (mobile) {
    const { data } = await db().from("player_profiles").select("id").eq("mobile_normalized", mobile).maybeSingle();
    mobileFree = !data;
  }
  const email = row.email?.trim().toLowerCase() || null;
  const base = { public_name: row.full_name.trim().slice(0, 120) || "Player", email, approval_status: "approved" };
  const first = await db()
    .from("player_profiles")
    .insert({ ...base, mobile_normalized: mobileFree ? mobile : null })
    .select("id")
    .single();
  if (!first.error) return (first.data as { id: string }).id;
  // The number was taken a moment ago: the profile is made without it.
  const second = await db().from("player_profiles").insert({ ...base, mobile_normalized: null }).select("id").single();
  if (second.error) throw new Error(second.error.message);
  return (second.data as { id: string }).id;
}

/* ---------------- the profile a link lands on ---------------- */

/**
 * The one candidate profile when it has no conflicting contact (`free`) and an
 * organisation whose row is among `rows` vouches for it (it created or added the
 * player): that organisation's word stands for the profile, as a code from it would.
 */
async function soleVouched(candidates: ProfileRow[], rows: PlayerRow[], orgOf: Map<string, string>, free: (c: ProfileRow) => boolean): Promise<ProfileRow | null> {
  if (candidates.length !== 1 || !free(candidates[0]!)) return null;
  const c = candidates[0]!;
  for (const org of new Set(rows.filter((r) => r.player_profile_id === c.id).map((r) => orgOf.get(r.tournament_id)))) {
    if (org && (await orgVouchesFor(org, c.id))) return c;
  }
  return null;
}

/** An offer stands only while its organisation added the player itself (not a profile it merely matched). */
export async function offerOrgVouches(orgId: string, profileId: string): Promise<boolean> {
  const { data } = await db().from("organization_players").select("source").eq("organization_id", orgId).eq("player_profile_id", profileId).maybeSingle();
  const source = (data as { source: string } | null)?.source;
  return Boolean(source) && source !== "matched";
}

type ProfileDecision = { ok: true; profileId: string | null; created: boolean } | { ok: false; status: number; error: string };

async function profileFor(userId: string, rows: PlayerRow[], proof: LinkProof, orgOf: Map<string, string>): Promise<ProfileDecision> {
  const mine = await accountProfile(userId);
  if (mine) {
    if (proof.kind === "offer" && proof.profileId !== mine.id) return { ok: false, status: 409, error: "Your account is already linked to another player profile. Ask the tournament desk for help." };
    return { ok: true, profileId: mine.id, created: false };
  }
  const candidates = await profilesById([...new Set(rows.map((r) => r.player_profile_id).filter((x): x is string => Boolean(x)))]);
  let target: ProfileRow | null = null;
  switch (proof.kind) {
    case "code": {
      const p = proof.row.player_profile_id ? candidates.find((c) => c.id === proof.row.player_profile_id) : null;
      // A code from an organisation that only matched the profile proves the row, not the profile.
      if (p && (await orgVouchesFor(orgOf.get(proof.row.tournament_id), p.id))) target = p;
      else if (p) return { ok: true, profileId: null, created: false };
      break;
    }
    case "phone":
      // The profile whose mobile it is; else (a profile with no mobile) one an organisation of these rows vouches for.
      target = candidates.find((c) => c.mobile_normalized === proof.phone) ?? (await soleVouched(candidates, rows, orgOf, (c) => !c.mobile_normalized));
      break;
    case "email":
      target = candidates.find((c) => sameEmail(c.email, proof.email)) ?? (await soleVouched(candidates, rows, orgOf, (c) => !c.email));
      break;
    case "offer": {
      const [p] = await profilesById([proof.profileId]);
      if (!p) return { ok: false, status: 404, error: NOTHING_TO_LINK };
      if (!(await offerOrgVouches(proof.orgId, p.id))) return { ok: false, status: 404, error: NOTHING_TO_LINK };
      target = p;
      break;
    }
  }
  if (target) {
    if (target.auth_user_id && target.auth_user_id !== userId) return { ok: false, status: 409, error: PROFILE_TAKEN };
    return { ok: true, profileId: target.id, created: false };
  }
  // A profile the proof does not reach (another person's contact on it, an organisation
  // that only matched it, or two of them for a platform admin to merge): the rows link
  // without it, and no new profile is made beside it.
  if (candidates.length) return { ok: true, profileId: null, created: false };
  const primary = proof.kind === "code" ? proof.row : rows[0]!;
  return { ok: true, profileId: await createProfileFrom(primary, proof.kind === "phone" ? proof.phone : null, proof.kind === "code"), created: true };
}

/* ---------------- linking ---------------- */

/**
 * Links `rows` (already proven by `proof`) to the account. Refuses a code row that
 * another account holds, a second person on one account, and a profile another
 * account speaks for. Rows another account holds are otherwise left out.
 */
export async function linkAccount(userId: string, rows: PlayerRow[], proof: LinkProof): Promise<ClaimResult> {
  const primary = proof.kind === "code" ? proof.row : rows[0];
  if (!primary) return { ok: false, status: 404, error: NOTHING_TO_LINK };
  const all = proof.kind === "code" && !rows.some((r) => r.id === primary.id) ? [primary, ...rows] : rows;

  // One account per row.
  const holders = await holdersOf(all.map((r) => r.id));
  const heldByOther = (id: string) => {
    const h = holders.get(id);
    return Boolean(h) && h !== userId;
  };
  if (proof.kind === "code" && heldByOther(primary.id)) return { ok: false, status: 409, error: CODE_TAKEN };
  const free = all.filter((r) => !heldByOther(r.id));
  if (!free.length) return { ok: false, status: 409, error: PROFILE_TAKEN };

  // One person per account: a second link must be the same person.
  const current = await claimedRows(userId);
  if (current.length && !current.some((p) => normalizePersonName(p.full_name) === normalizePersonName(primary.full_name))) {
    return { ok: false, status: 409, error: `This account is linked to ${current[0]!.full_name}. Unlink that player in Account first.` };
  }

  const orgOf = await orgsOfTournaments(free.map((r) => r.tournament_id));
  const decision = await profileFor(userId, free, proof, orgOf);
  if (!decision.ok) return decision;
  const profileId = decision.profileId;

  // The claims. The proven row first, alone: if another account took it a moment ago, the unique key refuses this one.
  const via = proof.kind === "code" ? primary.id : null;
  const toInsert = free.filter((r) => holders.get(r.id) !== userId);
  const first = toInsert.find((r) => r.id === primary.id);
  if (first) {
    const { error } = await db().from("player_claims").insert({ user_id: userId, player_id: first.id, via_player_id: via, proof: proof.kind });
    if (error) return { ok: false, status: 409, error: proof.kind === "code" ? CODE_TAKEN : PROFILE_TAKEN };
  }
  const rest = toInsert.filter((r) => r.id !== primary.id);
  if (rest.length) {
    const { error } = await db().from("player_claims").insert(rest.map((r) => ({ user_id: userId, player_id: r.id, via_player_id: via, proof: proof.kind })));
    // A race on one of them: link the others one by one.
    if (error) for (const r of rest) await db().from("player_claims").insert({ user_id: userId, player_id: r.id, via_player_id: via, proof: proof.kind });
  }

  if (profileId) await settleProfile(userId, profileId, free, proof, orgOf, decision.ok && decision.created);
  const player = await loadMyPlayer(userId);
  const nowHeld = await holdersOf(all.map((r) => r.id));
  return { ok: true, player: player!, linked: all.filter((r) => nowHeld.get(r.id) === userId).length };
}

/** The profile side of a link: speak for it, attach the rows that had none, record the organisations. */
async function settleProfile(userId: string, profileId: string, rows: PlayerRow[], proof: LinkProof, orgOf: Map<string, string>, created: boolean) {
  const now = new Date().toISOString();
  const { data: p } = await db().from("player_profiles").select(PROFILE_COLUMNS).eq("id", profileId).maybeSingle();
  const profile = p as ProfileRow | null;
  if (!profile) return;
  if (!profile.auth_user_id) {
    // Conditional: two links racing for one profile, the first wins; the unique index stops a second profile per account.
    // Through an offer, the account has only that organisation's word for the profile (owner_scope_org).
    await db()
      .from("player_profiles")
      .update({ auth_user_id: userId, owner_scope_org: proof.kind === "offer" ? proof.orgId : null, updated_at: now })
      .eq("id", profileId)
      .is("auth_user_id", null);
  } else if (profile.owner_scope_org && profile.auth_user_id === userId) {
    // A stronger proof lands on it: the profile's own mobile (a phone code) or its own email.
    const strong = (proof.kind === "phone" && profile.mobile_normalized === proof.phone) || (proof.kind === "email" && sameEmail(profile.email, proof.email));
    if (strong) await db().from("player_profiles").update({ owner_scope_org: null, updated_at: now }).eq("id", profileId).eq("auth_user_id", userId);
  }
  // Only a phone code (WhatsApp) confirms a number; an emailed code proves the address alone.
  if (proof.kind === "phone") {
    if (profile.mobile_normalized === proof.phone) {
      await db().from("player_profiles").update({ phone_verified_at: now, updated_at: now }).eq("id", profileId).eq("auth_user_id", userId);
    } else if (!profile.mobile_normalized) {
      const { data: taken } = await db().from("player_profiles").select("id").eq("mobile_normalized", proof.phone).maybeSingle();
      if (!taken) await db().from("player_profiles").update({ mobile_normalized: proof.phone, phone_verified_at: now, updated_at: now }).eq("id", profileId).eq("auth_user_id", userId);
    }
  }
  const { data: linked } = await db().from("player_profiles").select("auth_user_id").eq("id", profileId).maybeSingle();
  if ((linked as { auth_user_id: string | null } | null)?.auth_user_id !== userId) return;

  // Rows without a profile join this one; their organisations get the player.
  const orphans = rows.filter((r) => !r.player_profile_id).map((r) => r.id);
  if (orphans.length) await db().from("players").update({ player_profile_id: profileId, updated_at: now }).in("id", orphans).is("player_profile_id", null);
  const { data: rel } = await db().from("organization_players").select("organization_id").eq("player_profile_id", profileId);
  const already = new Set(((rel ?? []) as { organization_id: string }[]).map((r) => r.organization_id));
  for (const r of rows) {
    const org = orgOf.get(r.tournament_id);
    if (!org || already.has(org)) continue;
    already.add(org);
    // Made from this organisation's own row: theirs. Joined an existing profile: they see the name they typed until the player shares.
    if (created && r.id === rows[0]!.id) await ensureOrgPlayer(org, profileId, "tournament", "approved");
    else await ensureOrgPlayer(org, profileId, "matched", "approved", r.full_name);
  }
}

/**
 * The account's profile rows in organisations that vouch for the profile (or that
 * the player shared their details with), linked if nobody holds them yet: a new
 * tournament entry of a linked player shows up on its own. Returns how many were added.
 */
/**
 * The organisations whose data an account may see through its profile, or null for
 * every one. Null unless the account came to the profile through an organisation's
 * offer (owner_scope_org): then that organisation, and those where the account holds
 * an entry by its own proof.
 */
export async function profileReach(userId: string, profile: Pick<ProfileRow, "owner_scope_org"> | null): Promise<Set<string> | null> {
  if (!profile?.owner_scope_org) return null;
  const held = await claimedRows(userId);
  const orgOf = await orgsOfTournaments(held.map((r) => r.tournament_id));
  return new Set([profile.owner_scope_org, ...orgOf.values()]);
}

export async function syncProfileClaims(userId: string): Promise<number> {
  const profile = await accountProfile(userId);
  if (!profile) return 0;
  const { data } = await db().from("players").select(PLAYER_COLUMNS).eq("player_profile_id", profile.id).limit(500);
  const rows = (data ?? []) as PlayerRow[];
  if (!rows.length) return 0;
  const holders = await holdersOf(rows.map((r) => r.id));
  const loose = rows.filter((r) => !holders.has(r.id));
  if (!loose.length) return 0;
  const current = await claimedRows(userId);
  const name = current[0]?.full_name ?? profile.public_name;
  const orgOf = await orgsOfTournaments(loose.map((r) => r.tournament_id));
  const { data: rel } = await db().from("organization_players").select("organization_id, source").eq("player_profile_id", profile.id);
  const relations = (rel ?? []) as { organization_id: string; source: string }[];
  const trusted = new Set(relations.filter((r) => personFieldsVisibleFor(r.source, relations.filter((o) => o.organization_id !== r.organization_id).length)).map((r) => r.organization_id));
  // Ownership through one organisation's offer reaches only that organisation (and those the account proved itself at).
  const reach = await profileReach(userId, profile);
  if (reach) for (const org of [...trusted]) if (!reach.has(org)) trusted.delete(org);
  const add = loose.filter((r) => trusted.has(orgOf.get(r.tournament_id) ?? "") && normalizePersonName(r.full_name) === normalizePersonName(name));
  let n = 0;
  for (const r of add) {
    const { error } = await db().from("player_claims").insert({ user_id: userId, player_id: r.id, via_player_id: null, proof: "profile" });
    if (!error) n++;
  }
  return n;
}

/* ---------------- the code way in ---------------- */

/** The same person's other rows in the same organisation (identity.ts rule). */
export async function codeSiblings(row: PlayerRow): Promise<PlayerRow[]> {
  const queries = [];
  if (row.player_profile_id) queries.push(db().from("players").select(PLAYER_COLUMNS).eq("player_profile_id", row.player_profile_id).limit(200));
  if (row.phone) queries.push(db().from("players").select(PLAYER_COLUMNS).eq("phone", row.phone).limit(200));
  if (row.email) queries.push(db().from("players").select(PLAYER_COLUMNS).eq("email", row.email.toLowerCase()).limit(200));
  const found = new Map<string, PlayerRow>();
  for (const r of await Promise.all(queries)) for (const p of (r.data ?? []) as PlayerRow[]) found.set(p.id, p);
  const same = linkedRows(row, [...found.values()]);
  if (!same.length) return [];
  const orgOf = await orgsOfTournaments([row.tournament_id, ...same.map((s) => s.tournament_id)]);
  const org = orgOf.get(row.tournament_id);
  return same.filter((s) => org && orgOf.get(s.tournament_id) === org);
}

/** Links an account to the player whose code was entered, and the same person's rows in that organisation. */
export async function linkByCode(userId: string, row: PlayerRow): Promise<ClaimResult> {
  return linkAccount(userId, [row, ...(await codeSiblings(row))], { kind: "code", row });
}

/** POST /me/player/claim: a signed-in account enters a code. */
export async function claimPlayerCode(caller: ClaimCaller & { userId: string }, rawCode: string): Promise<ClaimResult> {
  const found = await findPlayerByCode(caller, rawCode);
  if (!found.ok) return found;
  return linkByCode(caller.userId, found.row);
}

/* ---------------- sharing with an organisation ---------------- */

export interface OrgShare {
  organizationId: string;
  name: string;
  slug: string;
  /** Whether the organisation sees the player's contact details. */
  sharing: boolean;
  /** The player can change it: the organisation only matched them and the player holds its entries. */
  canShare: boolean;
}

/** The organisations of the account's entries, and whether each sees the player's details. */
export async function orgShares(userId: string): Promise<OrgShare[]> {
  const profile = await accountProfile(userId);
  const rows = await claimedRows(userId);
  const orgOf = await orgsOfTournaments(rows.map((r) => r.tournament_id));
  const orgIds = [...new Set([...orgOf.values()])];
  if (!orgIds.length) return [];
  const [{ data: orgs }, { data: rel }] = await Promise.all([
    db().from("organizations").select("id, name, slug").in("id", orgIds),
    profile ? db().from("organization_players").select("organization_id, source").eq("player_profile_id", profile.id) : Promise.resolve({ data: [] }),
  ]);
  const relations = (rel ?? []) as { organization_id: string; source: string }[];
  return ((orgs ?? []) as { id: string; name: string; slug: string }[]).map((o) => {
    const mine = relations.find((r) => r.organization_id === o.id);
    const others = relations.filter((r) => r.organization_id !== o.id).length;
    const sharing = Boolean(mine) && personFieldsVisibleFor(mine!.source, others);
    return { organizationId: o.id, name: o.name, slug: o.slug, sharing, canShare: Boolean(profile) && mine?.source === "matched" && !sharing };
  });
}

/**
 * The player shares their details with an organisation that only matched them:
 * its link becomes 'link' (src/lib/orgs/personFields.ts), and it sees their
 * contact fields like the organisations that added them. Same answer for an
 * organisation that is not theirs and one that does not exist.
 */
export async function shareWithOrg(userId: string, organizationId: string): Promise<boolean> {
  const shares = await orgShares(userId);
  const s = shares.find((x) => x.organizationId === organizationId);
  if (!s?.canShare) return false;
  const profile = await accountProfile(userId);
  if (!profile) return false;
  const { data } = await db()
    .from("organization_players")
    .update({ source: "link", updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("player_profile_id", profile.id)
    .eq("source", "matched")
    .select("organization_id");
  if (data?.length) await syncProfileClaims(userId);
  return Boolean(data?.length);
}
