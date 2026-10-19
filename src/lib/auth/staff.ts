/**
 * Who is behind a staff request, re-checked against the database every time.
 *
 * Three kinds of staff credential reach the console and the referee/operator APIs:
 *
 * - member: a personal account (Google or email + password). The server checked
 *   the Supabase session once, at sign-in, then issued its own signed token
 *   `{user, org, role, exp}` (staffToken.ts). On every request the membership
 *   must still be active (or the user still a platform admin) and the
 *   organisation still approved; the role is the one in the database now, not
 *   the one in the token. Removal or suspension takes effect on the next request.
 * - code: an event code (referee / TV operator), optionally scoped to one
 *   tournament. Every request re-reads the code row: a revoked or expired code
 *   fails at once with a clear message.
 * - shared: the old shared role passwords. They reach the Move Beyond
 *   organisation only (the World Cup on 2 Nov runs on them) and are retired at
 *   the end of Phase 0.5.
 *
 * Bearer header first (the app), then the staff cookie (the web): `__Host-mb_session`
 * (Secure, host-only, path /, so a sibling subdomain can never plant or overwrite
 * it); on a localhost development server only, the plain `mb_session`.
 */
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { db } from "../supabase";
import { bearerToken, createSessionToken, roleForPassword, staffCookieFor, staffCookieNames, verifySessionToken } from "../auth";
import { hashEventCode, normalizeEventCode } from "../orgs/codes";
import { principalReaches, resolveEntity } from "../orgs/scope";
import { CARRY_HOURS, FINISHED_STATUSES } from "../orgs/courtScope";
import { MOVE_BEYOND_SLUG, isUuid, permissionRole, type OrgRole, type OrgStatus } from "../orgs/roles";
import type { Role } from "../types";
import type { CourtScope } from "../orgs/courtScope";
import { resolveCourtScope } from "../orgs/courtCodes";
import { checkRefereePin, codeNeedsPin, endRefereeSession, masterTournamentIds, refereeForToken, startRefereeSession, type RefereeIdentity } from "../referees/server";
import { splitCodeAndPin } from "../referees/rules";
import {
  STAFF_APP_HOURS,
  STAFF_WEB_HOURS,
  MAX_CARRY_MATCHES,
  isStaffTokenShaped,
  signStaffToken,
  staffSecret,
  verifyStaffToken,
} from "./staffToken";

export type StaffKind = "member" | "code" | "shared";

export interface StaffPrincipal {
  kind: StaffKind;
  orgId: string;
  orgSlug: string;
  orgName: string;
  /** The organisation role (owner … operator). */
  orgRole: OrgRole;
  /** The console role it acts as in the permission matrix (owner → admin). */
  role: Role;
  /** Supabase auth user id (members only). */
  userId: string | null;
  /** organization_codes.id (codes only). */
  codeId: string | null;
  /** A code scoped to one tournament (or a session's hidden tournament). */
  scopeTournamentId: string | null;
  /**
   * A court referee code (migration 0034): only the matches on this physical court,
   * in the code's event group or tournament. Resolved from the database on every
   * request, so a match moved to or from the court counts at once.
   */
  scopeCourt?: CourtScope | null;
  /**
   * A carry-over credential (court codes, migration 0034): after the referee switched
   * courts, the old court's code reaches only these matches (unsent points or an
   * unfinished match on the old court), never a new one. src/lib/orgs/scope.ts.
   */
  scopeMatchIds?: string[] | null;
  /**
   * A master referee code (migration 0035): every tournament of its event group (or
   * its one tournament, or the organisation's open events), read on every request.
   */
  scopeTournamentIds?: string[] | null;
  /**
   * The referee signed in with their PIN (court and master codes, migration 0035):
   * re-read on every request. Audit rows and score events carry their name and id.
   */
  referee?: RefereeIdentity | null;
  /** May use Move Beyond's platform pages (Discover, merging profiles). */
  platformAdmin: boolean;
}

export type StaffRefusal =
  | "signed_out"
  | "code_revoked"
  | "code_expired"
  | "membership_ended"
  | "org_suspended"
  | "org_pending"
  | "unavailable"
  // Referee PINs (migration 0035): a court or master token without a referee (signed before
  // PINs), or whose referee was removed, had their PIN reset or signed out.
  | "pin_required"
  | "referee_ended";

export const REFUSAL_MESSAGE: Record<StaffRefusal, string> = {
  signed_out: "Sign in to continue.",
  code_revoked: "This event code was revoked. Ask the organiser for a new code.",
  code_expired: "This event code has expired. Ask the organiser for a new code.",
  membership_ended: "Your access to this organisation has ended. Ask its owner if this is a mistake.",
  org_suspended: "This organisation is suspended. Contact Move Beyond.",
  org_pending: "This organisation is not approved yet.",
  unavailable: "Staff sign-in is not available right now.",
  pin_required: "Sign in again with the court code and your 4-digit referee PIN.",
  referee_ended: "Your referee sign-in has ended. Sign in again with the court code and your PIN.",
};

export type StaffResolution = { ok: true; staff: StaffPrincipal } | { ok: false; reason: StaffRefusal };

const refused = (reason: StaffRefusal): StaffResolution => ({ ok: false, reason });

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
}

async function orgWhere(column: "id" | "slug", value: string): Promise<OrgRow | null> {
  const { data } = await db().from("organizations").select("id, slug, name, status").eq(column, value).maybeSingle();
  return (data as OrgRow | null) ?? null;
}

/** The Move Beyond organisation (owner of everything before organisations). */
export function moveBeyondOrg(): Promise<OrgRow | null> {
  return orgWhere("slug", MOVE_BEYOND_SLUG);
}

function orgRefusal(org: OrgRow | null): StaffRefusal | null {
  if (!org) return "signed_out";
  if (org.status === "suspended") return "org_suspended";
  if (org.status !== "approved") return "org_pending";
  return null;
}

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await db().from("platform_admins").select("auth_user_id").eq("auth_user_id", userId).maybeSingle();
  return Boolean(data);
}

const CODE_ROW = "id, organization_id, role, tournament_id, event_group_id, court_name, referee_id, label, expires_at, revoked_at";
interface CodeRow {
  id: string;
  organization_id: string;
  role: "referee" | "operator" | "master_referee";
  referee_id: string | null;
  tournament_id: string | null;
  event_group_id: string | null;
  court_name: string | null;
  label: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/** Resolves one presented token. Null when it is not a staff token at all. */
export async function resolveStaffToken(token: string, now = Date.now()): Promise<StaffResolution | null> {
  if (token.startsWith("mbs1.")) {
    let secret: string;
    try {
      secret = staffSecret();
    } catch (err) {
      console.error("staff sessions unavailable:", (err as Error).message);
      return refused("unavailable");
    }
    const p = verifyStaffToken(token, secret, now);
    if (!p) return refused("signed_out");
    const org = await orgWhere("id", p.o);
    const blocked = orgRefusal(org);
    if (blocked) return refused(blocked);
    const base = { orgId: org!.id, orgSlug: org!.slug, orgName: org!.name };

    if (p.k === "m") {
      const [{ data: member }, platform] = await Promise.all([
        db()
          .from("organization_members")
          .select("role")
          .eq("organization_id", p.o)
          .eq("auth_user_id", p.u)
          .eq("status", "active")
          .maybeSingle(),
        isPlatformAdmin(p.u),
      ]);
      const memberRole = (member as { role: OrgRole } | null)?.role ?? null;
      if (!memberRole && !platform) return refused("membership_ended");
      // A platform admin acts as the owner of whichever organisation they switch to.
      const orgRole: OrgRole = platform ? "owner" : memberRole!;
      return {
        ok: true,
        staff: { kind: "member", ...base, orgRole, role: permissionRole(orgRole), userId: p.u, codeId: null, scopeTournamentId: null, platformAdmin: platform },
      };
    }

    const { data: row } = await db()
      .from("organization_codes")
      .select(CODE_ROW)
      .eq("id", p.c)
      .maybeSingle();
    const code = row as CodeRow | null;
    if (!code || code.organization_id !== p.o) return refused("signed_out");
    if (code.revoked_at) return refused("code_revoked");
    if (code.expires_at && Date.parse(code.expires_at) <= now) return refused("code_expired");
    // A referee code (court, whole-event or master): the referee the token names, re-checked.
    let referee: RefereeIdentity | null = null;
    if (codeNeedsPin(code)) {
      referee = await refereeForToken(p, code, now);
      if (!referee) return refused(p.p ? "referee_ended" : "pin_required");
    }
    const master = code.role === "master_referee";
    const [scopeCourt, scopeTournamentIds] = await Promise.all([
      code.court_name ? resolveCourtScope(code) : Promise.resolve(null),
      master ? masterTournamentIds(code) : Promise.resolve(null),
    ]);
    const consoleRole: "referee" | "operator" = code.role === "operator" ? "operator" : "referee";
    return {
      ok: true,
      staff: {
        kind: "code",
        ...base,
        orgRole: consoleRole,
        role: consoleRole,
        userId: null,
        codeId: code.id,
        scopeTournamentId: code.tournament_id,
        scopeCourt,
        scopeMatchIds: p.m ?? null,
        scopeTournamentIds,
        referee,
        platformAdmin: false,
      },
    };
  }

  const legacyRole = verifySessionToken(token);
  if (!legacyRole) return null;
  // The shared passwords only ever reach Move Beyond. Missing organisation → no access.
  const mb = await moveBeyondOrg();
  const blocked = orgRefusal(mb);
  if (blocked) return refused(blocked);
  return {
    ok: true,
    staff: {
      kind: "shared",
      orgId: mb!.id,
      orgSlug: mb!.slug,
      orgName: mb!.name,
      orgRole: legacyRole,
      role: legacyRole,
      userId: null,
      codeId: null,
      scopeTournamentId: null,
      // Never: a shared password is not a person. Move Beyond's platform pages
      // (Discover, flags, merging players) need a real platform_admins row, reached
      // by signing in with that person's own Google or email account.
      platformAdmin: false,
    },
  };
}

/** This request's staff resolution (memoised per render). */
export const currentStaffResolution = cache(async (): Promise<StaffResolution> => {
  const h = await headers();
  const bearer = bearerToken(h);
  if (bearer && isStaffTokenShaped(bearer)) {
    const r = await resolveStaffToken(bearer);
    if (r) return r;
  }
  const store = await cookies();
  for (const name of staffCookieNames(h.get("host"))) {
    const cookie = store.get(name)?.value;
    if (!cookie) continue;
    const r = await resolveStaffToken(cookie);
    if (r) return r;
  }
  return refused("signed_out");
});

/** The staff principal of this request, or null. */
export async function currentStaff(): Promise<StaffPrincipal | null> {
  const r = await currentStaffResolution();
  return r.ok ? r.staff : null;
}

/** Like currentStaff, but null outside a request (scripts, background work) instead of throwing. */
export async function currentStaffIfAny(): Promise<StaffPrincipal | null> {
  try {
    return await currentStaff();
  } catch {
    return null;
  }
}

/* ---------------- issuing ---------------- */

export async function setStaffCookie(token: string, hours = STAFF_WEB_HOURS) {
  const { name, secure } = staffCookieFor((await headers()).get("host"));
  (await cookies()).set(name, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: hours * 3600,
  });
}

export function memberToken(userId: string, orgId: string, role: OrgRole, hours = STAFF_WEB_HOURS, now = Date.now()): string {
  return signStaffToken({ v: 1, k: "m", u: userId, o: orgId, r: role, iat: now, exp: now + hours * 3600_000 }, staffSecret());
}

export interface OrgChoice {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
}

/** The approved organisations a signed-in person may act for, by name. Platform admins: all of them. */
export async function staffOrgsFor(userId: string): Promise<OrgChoice[]> {
  if (!isUuid(userId)) return [];
  const [{ data: rows }, platform] = await Promise.all([
    db().from("organization_members").select("organization_id, role").eq("auth_user_id", userId).eq("status", "active"),
    isPlatformAdmin(userId),
  ]);
  const roleOf = new Map(((rows ?? []) as { organization_id: string; role: OrgRole }[]).map((r) => [r.organization_id, r.role]));
  let q = db().from("organizations").select("id, slug, name, status").eq("status", "approved");
  if (!platform) {
    if (roleOf.size === 0) return [];
    q = q.in("id", [...roleOf.keys()]);
  }
  const { data: orgs } = await q.order("name");
  return ((orgs ?? []) as OrgRow[]).map((o) => ({ id: o.id, slug: o.slug, name: o.name, role: platform ? "owner" : roleOf.get(o.id)! }));
}

/**
 * The last step of a personal staff sign-in, once the server itself has checked
 * the Supabase session (Google or email + password): the organisation to act
 * for (the first by name; the switcher offers the others) and its signed token.
 */
export async function finishStaffSignIn(
  userId: string,
  preferOrgId?: string | null,
): Promise<{ ok: true; token: string; org: OrgChoice; choices: number } | { ok: false; reason: "no_org" | "unavailable" }> {
  const orgs = await staffOrgsFor(userId);
  if (orgs.length === 0) return { ok: false, reason: "no_org" };
  // Just accepted an invite: act for that organisation first.
  const org = orgs.find((o) => o.id === preferOrgId) ?? orgs[0];
  try {
    // Several organisations: the switcher still comes next, so nobody lands in one unawares.
    return { ok: true, token: memberToken(userId, org.id, org.role), org, choices: orgs.length };
  } catch (err) {
    console.error("staff sessions unavailable:", (err as Error).message);
    return { ok: false, reason: "unavailable" };
  }
}

type Reach = Pick<StaffPrincipal, "orgId" | "scopeTournamentId" | "scopeCourt" | "scopeTournamentIds">;

export interface CourtSignIn {
  name: string;
  eventGroupId: string | null;
  tournamentIds: string[];
}

export interface SignedInReferee {
  id: string;
  name: string;
  role: "referee" | "master_referee";
  sessionId: string;
}

export type CodeSignIn =
  | {
      ok: true;
      token: string;
      kind: "shared" | "code";
      role: Role;
      orgId: string;
      orgName: string;
      orgSlug: string;
      scopeTournamentId: string | null;
      /** A court referee code: its court (migration 0034). */
      court: CourtSignIn | null;
      /** What the new credential reaches (to decide which old matches it does not). */
      reach: Reach;
      label: string | null;
      expiresAt: string;
      codeId: string | null;
      /** The referee signed in with their PIN (court and master codes, migration 0035). */
      referee: SignedInReferee | null;
    }
  | {
      ok: false;
      error: string;
      reason: "wrong_code" | "wrong_pin" | "pin_locked" | StaffRefusal;
      /** pin_required: the code is right; its court (null for a master code). */
      court?: string | null;
      master?: boolean;
      retryAfterSeconds?: number;
    };

export interface AccessCodeOptions {
  /** The referee PIN typed with a court or master code (or inside the code: 1.0.1). */
  pin?: unknown;
  /** For the PIN brakes (src/lib/referees/server.ts). */
  ip?: string;
  via?: "web" | "app";
  /** The phone (the app's install token), recorded on a referee's sign-in. */
  installationId?: string | null;
}

export const PIN_MESSAGES = {
  pin_required: "This referee code needs your 4-digit referee PIN.",
  pin_required_legacy: "This referee code needs your 4-digit referee PIN: type the code, a space, then your PIN.",
  wrong_pin: "Wrong PIN. Check the 4 digits the organiser gave you.",
  pin_locked: "Too many wrong PINs for this code. It is locked for 5 minutes.",
} as const;

/**
 * An access code typed on the web login or in the app: a shared role password
 * (Move Beyond only) or an organisation's event code. The caller rate-limits.
 */
export async function signInWithAccessCode(raw: string, hours: number, opts: AccessCodeOptions = {}, now = Date.now()): Promise<CodeSignIn> {
  const wrong: CodeSignIn = { ok: false, error: "Wrong access code.", reason: "wrong_code" };
  const input = raw.trim().slice(0, 200);
  if (!input) return wrong;

  const sharedRole = roleForPassword(input);
  if (sharedRole) {
    const mb = await moveBeyondOrg();
    const blocked = orgRefusal(mb);
    if (blocked) return { ok: false, error: REFUSAL_MESSAGE[blocked], reason: blocked };
    return {
      ok: true,
      token: createSessionToken(sharedRole, hours),
      kind: "shared",
      role: sharedRole,
      orgId: mb!.id,
      orgName: mb!.name,
      orgSlug: mb!.slug,
      scopeTournamentId: null,
      court: null,
      reach: { orgId: mb!.id, scopeTournamentId: null, scopeCourt: null },
      label: null,
      expiresAt: new Date(now + hours * 3600_000).toISOString(),
      codeId: null,
      referee: null,
    };
  }

  // Move Score 1.0.1 has one field: "<referee code> <PIN>" or "<referee code>-<PIN>" (court, whole-event or master code).
  const combined = normalizeEventCode(input) ? null : splitCodeAndPin(input);
  const code = combined?.code ?? normalizeEventCode(input);
  const pin = combined?.pin ?? opts.pin;
  if (!code) return wrong;
  let codeHash: string;
  try {
    codeHash = hashEventCode(code);
  } catch (err) {
    console.error("event codes unavailable:", (err as Error).message);
    return { ok: false, error: REFUSAL_MESSAGE.unavailable, reason: "unavailable" };
  }
  const { data } = await db()
    .from("organization_codes")
    .select(CODE_ROW)
    .eq("code_hash", codeHash)
    .maybeSingle();
  const row = data as CodeRow | null;
  if (!row) return wrong;
  if (row.revoked_at) return { ok: false, error: REFUSAL_MESSAGE.code_revoked, reason: "code_revoked" };
  const codeExpiry = row.expires_at ? Date.parse(row.expires_at) : Infinity;
  if (codeExpiry <= now) return { ok: false, error: REFUSAL_MESSAGE.code_expired, reason: "code_expired" };
  const org = await orgWhere("id", row.organization_id);
  const blocked = orgRefusal(org);
  if (blocked) return { ok: false, error: REFUSAL_MESSAGE[blocked], reason: blocked };
  const master = row.role === "master_referee";
  // Every referee code is useless without a referee PIN (court, whole-event and master codes).
  let referee: SignedInReferee | null = null;
  const exp = Math.min(now + hours * 3600_000, codeExpiry);
  if (codeNeedsPin(row)) {
    const typedPin = typeof pin === "string" || typeof pin === "number" ? String(pin).trim() : "";
    if (!typedPin) {
      return { ok: false, error: opts.via === "app" ? PIN_MESSAGES.pin_required_legacy : PIN_MESSAGES.pin_required, reason: "pin_required", court: row.court_name, master };
    }
    const checked = await checkRefereePin(row, typedPin, opts.ip ?? "unknown");
    if (!checked.ok) {
      if (checked.reason === "unavailable") return { ok: false, error: REFUSAL_MESSAGE.unavailable, reason: "unavailable" };
      return { ok: false, error: PIN_MESSAGES[checked.reason], reason: checked.reason, retryAfterSeconds: checked.retryAfterSeconds, court: row.court_name, master };
    }
    const sessionId = await startRefereeSession(row, checked.referee, {
      via: opts.via === "app" ? (combined ? "app_legacy" : "app") : "web",
      expiresAt: new Date(exp).toISOString(),
      installationId: opts.installationId ?? null,
    });
    if (!sessionId) return { ok: false, error: REFUSAL_MESSAGE.unavailable, reason: "unavailable" };
    referee = { id: checked.referee.id, name: checked.referee.name, role: master ? "master_referee" : "referee", sessionId };
  }
  const [scopeCourt, scopeTournamentIds] = await Promise.all([
    row.court_name ? resolveCourtScope(row) : Promise.resolve(null),
    master ? masterTournamentIds(row) : Promise.resolve(null),
  ]);
  const consoleRole: "referee" | "operator" = row.role === "operator" ? "operator" : "referee";
  let token: string;
  try {
    token = signStaffToken(
      { v: 1, k: "c", c: row.id, o: row.organization_id, r: consoleRole, t: row.tournament_id, ...(referee ? { p: referee.id, s: referee.sessionId } : {}), iat: now, exp },
      staffSecret(),
    );
  } catch (err) {
    console.error("staff sessions unavailable:", (err as Error).message);
    return { ok: false, error: REFUSAL_MESSAGE.unavailable, reason: "unavailable" };
  }
  await db().from("organization_codes").update({ last_used_at: new Date(now).toISOString() }).eq("id", row.id);
  return {
    ok: true,
    token,
    kind: "code",
    role: consoleRole,
    orgId: org!.id,
    orgName: org!.name,
    orgSlug: org!.slug,
    scopeTournamentId: row.tournament_id,
    court: scopeCourt ? { name: scopeCourt.name, eventGroupId: scopeCourt.eventGroupId, tournamentIds: scopeCourt.tournamentIds } : null,
    reach: { orgId: row.organization_id, scopeTournamentId: row.tournament_id, scopeCourt, scopeTournamentIds },
    label: row.label,
    expiresAt: new Date(exp).toISOString(),
    codeId: row.id,
    referee,
  };
}

/* ---------------- switching courts: the carry-over credential ---------------- */

export interface Carry {
  token: string;
  matchIds: string[];
  court: string | null;
  expiresAt: string;
}

/**
 * Switching courts is never blocked (owner's decision, 19 Oct 2026). When the
 * previous credential is a referee code and the phone still holds unsent points
 * (`pending`) or an unfinished match (`open`) that the new credential does not
 * reach, the old code keeps reaching exactly those matches through a carry-over
 * token (`m` in src/lib/auth/staffToken.ts), never a new one. It lapses by itself:
 * a match the server has finished drops out of it after CARRY_GRACE_MINUTES
 * (src/lib/orgs/courtScope.ts), the token after CARRY_HOURS, and revoking the old
 * code ends it at once. Null when nothing needs carrying.
 */
export async function issueCarry(
  previous: StaffPrincipal | null,
  next: Reach,
  matches: { pending?: string[]; open?: string[] },
  now = Date.now(),
): Promise<Carry | null> {
  if (!previous || previous.kind !== "code" || !previous.codeId || previous.role !== "referee") return null;
  const pending = new Set((matches.pending ?? []).filter(isUuid));
  const ids = [...new Set([...pending, ...(matches.open ?? []).filter(isUuid)])].slice(0, MAX_CARRY_MATCHES);
  const keep: string[] = [];
  for (const id of ids) {
    const scope = await resolveEntity({ match: id });
    if (!scope || !principalReaches(previous, scope, now)) continue;
    const newReaches: boolean = principalReaches(next, { ...scope }, now);
    if (newReaches) continue;
    // An unfinished match is carried while it is unfinished; one with unsent points, whatever the server says.
    if (!pending.has(id) && FINISHED_STATUSES.has(scope.matchStatus ?? "")) continue;
    keep.push(id);
  }
  if (!keep.length) return null;
  const exp = now + CARRY_HOURS * 3600_000;
  let token: string;
  try {
    const who = previous.referee ? { p: previous.referee.id, s: previous.referee.sessionId } : {};
    token = signStaffToken({ v: 1, k: "c", c: previous.codeId, o: previous.orgId, r: "referee", t: previous.scopeTournamentId, m: keep, ...who, iat: now, exp }, staffSecret());
  } catch (err) {
    console.error("staff sessions unavailable:", (err as Error).message);
    return null;
  }
  return { token, matchIds: keep, court: previous.scopeCourt?.name ?? null, expiresAt: new Date(exp).toISOString() };
}

/** The carry-over cookie of a browser (one; a second switch replaces it, carrying both courts' matches it still holds). */
export function carryCookieFor(host: string | null | undefined): { name: string; secure: boolean } {
  const { secure } = staffCookieFor(host);
  return { name: secure ? "__Host-mb_carry" : "mb_carry", secure };
}

export async function setCarryCookie(carry: Carry | null) {
  const { name, secure } = carryCookieFor((await headers()).get("host"));
  const store = await cookies();
  if (!carry) store.set(name, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 });
  else store.set(name, carry.token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: CARRY_HOURS * 3600 });
}

/**
 * This request's carry-over credentials: the app's `X-Staff-Carry` header (up to
 * three tokens, comma-separated) and the browser's carry cookie. Only working
 * carry-over tokens (with their match list) count; anything else is ignored.
 */
export const currentCarries = cache(async (): Promise<StaffPrincipal[]> => {
  const h = await headers();
  const raw = (h.get("x-staff-carry") ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 3);
  const store = await cookies();
  const host = h.get("host");
  for (const name of [carryCookieFor(host).name, ...(isLocalHostName(host) ? ["__Host-mb_carry"] : [])]) {
    const v = store.get(name)?.value;
    if (v) raw.push(v);
  }
  const out: StaffPrincipal[] = [];
  for (const t of raw.slice(0, 4)) {
    if (!t.startsWith("mbs1.")) continue;
    const r = await resolveStaffToken(t);
    if (r?.ok && r.staff.scopeMatchIds?.length) out.push(r.staff);
  }
  return out;
});

const isLocalHostName = (host: string | null | undefined) => !carryCookieFor(host).secure;

/**
 * Who acts on one match in this request: the signed-in principal when it reaches
 * the match, else a carry-over credential that does (the old court's code, for a
 * match it still holds). Null when neither reaches it.
 */
export async function principalForMatch(primary: StaffPrincipal, matchId: string): Promise<StaffPrincipal | null> {
  const scope = await resolveEntity({ match: matchId });
  if (principalReaches(primary, scope)) return primary;
  for (const c of await currentCarries()) if (principalReaches(c, scope)) return c;
  return null;
}

/**
 * A referee's previous sign-in ends when they sign in again elsewhere (switching
 * courts); a carry-over keeps naming it for the old court's matches, so it is only
 * marked replaced when nothing is carried.
 */
export async function replacePreviousReferee(previous: StaffPrincipal | null, carried: boolean): Promise<void> {
  if (!previous?.referee || carried) return;
  await endRefereeSession(previous.referee.sessionId, "replaced");
}

export { STAFF_APP_HOURS, STAFF_WEB_HOURS };
