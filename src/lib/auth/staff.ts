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
import { MOVE_BEYOND_SLUG, isUuid, permissionRole, type OrgRole, type OrgStatus } from "../orgs/roles";
import type { Role } from "../types";
import {
  STAFF_APP_HOURS,
  STAFF_WEB_HOURS,
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
  /** May use Move Beyond's platform pages (Discover, merging profiles). */
  platformAdmin: boolean;
}

export type StaffRefusal = "signed_out" | "code_revoked" | "code_expired" | "membership_ended" | "org_suspended" | "org_pending" | "unavailable";

export const REFUSAL_MESSAGE: Record<StaffRefusal, string> = {
  signed_out: "Sign in to continue.",
  code_revoked: "This event code was revoked. Ask the organiser for a new code.",
  code_expired: "This event code has expired. Ask the organiser for a new code.",
  membership_ended: "Your access to this organisation has ended. Ask its owner if this is a mistake.",
  org_suspended: "This organisation is suspended. Contact Move Beyond.",
  org_pending: "This organisation is not approved yet.",
  unavailable: "Staff sign-in is not available right now.",
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

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await db().from("platform_admins").select("auth_user_id").eq("auth_user_id", userId).maybeSingle();
  return Boolean(data);
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
      .select("id, organization_id, role, tournament_id, expires_at, revoked_at")
      .eq("id", p.c)
      .maybeSingle();
    const code = row as { id: string; organization_id: string; role: "referee" | "operator"; tournament_id: string | null; expires_at: string | null; revoked_at: string | null } | null;
    if (!code || code.organization_id !== p.o) return refused("signed_out");
    if (code.revoked_at) return refused("code_revoked");
    if (code.expires_at && Date.parse(code.expires_at) <= now) return refused("code_expired");
    return {
      ok: true,
      staff: { kind: "code", ...base, orgRole: code.role, role: code.role, userId: null, codeId: code.id, scopeTournamentId: code.tournament_id, platformAdmin: false },
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

export type CodeSignIn =
  | { ok: true; token: string; kind: "shared" | "code"; role: Role; orgId: string; orgName: string; orgSlug: string; scopeTournamentId: string | null; expiresAt: string; codeId: string | null }
  | { ok: false; error: string; reason: "wrong_code" | StaffRefusal };

/**
 * An access code typed on the web login or in the app: a shared role password
 * (Move Beyond only) or an organisation's event code. The caller rate-limits.
 */
export async function signInWithAccessCode(raw: string, hours: number, now = Date.now()): Promise<CodeSignIn> {
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
      expiresAt: new Date(now + hours * 3600_000).toISOString(),
      codeId: null,
    };
  }

  const code = normalizeEventCode(input);
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
    .select("id, organization_id, role, tournament_id, expires_at, revoked_at")
    .eq("code_hash", codeHash)
    .maybeSingle();
  const row = data as { id: string; organization_id: string; role: "referee" | "operator"; tournament_id: string | null; expires_at: string | null; revoked_at: string | null } | null;
  if (!row) return wrong;
  if (row.revoked_at) return { ok: false, error: REFUSAL_MESSAGE.code_revoked, reason: "code_revoked" };
  const codeExpiry = row.expires_at ? Date.parse(row.expires_at) : Infinity;
  if (codeExpiry <= now) return { ok: false, error: REFUSAL_MESSAGE.code_expired, reason: "code_expired" };
  const org = await orgWhere("id", row.organization_id);
  const blocked = orgRefusal(org);
  if (blocked) return { ok: false, error: REFUSAL_MESSAGE[blocked], reason: blocked };
  const exp = Math.min(now + hours * 3600_000, codeExpiry);
  let token: string;
  try {
    token = signStaffToken({ v: 1, k: "c", c: row.id, o: row.organization_id, r: row.role, t: row.tournament_id, iat: now, exp }, staffSecret());
  } catch (err) {
    console.error("staff sessions unavailable:", (err as Error).message);
    return { ok: false, error: REFUSAL_MESSAGE.unavailable, reason: "unavailable" };
  }
  await db().from("organization_codes").update({ last_used_at: new Date(now).toISOString() }).eq("id", row.id);
  return {
    ok: true,
    token,
    kind: "code",
    role: row.role,
    orgId: org!.id,
    orgName: org!.name,
    orgSlug: org!.slug,
    scopeTournamentId: row.tournament_id,
    expiresAt: new Date(exp).toISOString(),
    codeId: row.id,
  };
}

export { STAFF_APP_HOURS, STAFF_WEB_HOURS };
