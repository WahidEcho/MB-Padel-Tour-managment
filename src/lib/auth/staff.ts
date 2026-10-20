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
import { checkRefereePin, codeNeedsPin, endRefereeSession, masterTournamentIds, refereeChoices, refereeForToken, startRefereeSession, type PinCheck, type RefereeIdentity } from "../referees/server";
import { PIN_LOCK_MINUTES, splitCodeAndPin, type RefereeChoice } from "../referees/rules";
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
  /** When the presented code token lapses (ms; code tokens only): a carry-over never outlives it. */
  tokenExpiresAt?: number | null;
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
        tokenExpiresAt: p.exp,
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
      reason: "wrong_code" | "wrong_pin" | "pin_locked" | "pin_paused" | "pin_busy" | StaffRefusal;
      /** pin_required: the code is right; its court (null for a master code). */
      court?: string | null;
      master?: boolean;
      retryAfterSeconds?: number;
      /** pin_required (and a wrong pick): the names to choose from on the PIN step (audit H1). */
      referees?: RefereeChoice[];
      /** wrong_pin with a picked name: wrong PINs left before that referee is locked. */
      triesLeft?: number;
    };

export interface AccessCodeOptions {
  /** The referee PIN typed with a court or master code (or inside the code: 1.0.1). */
  pin?: unknown;
  /** The referee picked on the PIN step (audit H1); absent from Move Score 1.0.1. */
  refereeId?: unknown;
  /** "app:<installation id>" / "web:<browser id>": a device that signed this referee in today gets back in while they are locked. */
  deviceKey?: string | null;
  /** For the PIN brakes (src/lib/referees/server.ts). */
  ip?: string;
  via?: "web" | "app";
  /** The phone (the app's install token), recorded on a referee's sign-in. */
  installationId?: string | null;
}

const minutes = (secs: number | undefined) => Math.max(1, Math.ceil((secs ?? PIN_LOCK_MINUTES * 60) / 60));

export const PIN_MESSAGES = {
  pin_required: "This referee code needs your 4-digit referee PIN.",
  pin_required_legacy: "This referee code needs your 4-digit referee PIN: type the code, a space, then your PIN.",
  pick_name: "Pick your name, then type your 4-digit referee PIN.",
  unknown_referee: "That name is not on this code's list. Pick your name from the list.",
  wrong_pin: "Wrong PIN. Check the 4 digits the organiser gave you.",
  pin_locked: "Too many wrong PINs. Wait 5 minutes and try again.",
} as const;

/** The words for a PIN that did not sign in (audit H1): who is locked, for how long, and what still works. */
export function pinMessage(c: Extract<PinCheck, { ok: false }>): string {
  const who = c.refereeName ?? null;
  switch (c.reason) {
    case "wrong_pin":
      if (!who) return PIN_MESSAGES.wrong_pin;
      if (c.triesLeft === 0) return `Wrong PIN for ${who}. ${who} is now locked for ${PIN_LOCK_MINUTES} minutes; other referees can still sign in.`;
      return `Wrong PIN for ${who}.${c.triesLeft !== undefined ? ` ${c.triesLeft} ${c.triesLeft === 1 ? "try" : "tries"} left before ${who} is locked for ${PIN_LOCK_MINUTES} minutes.` : ""}`;
    case "pin_locked":
      return who
        ? `Too many wrong PINs for ${who}: locked for ${minutes(c.retryAfterSeconds)} more minute${minutes(c.retryAfterSeconds) === 1 ? "" : "s"}. Other referees can still sign in, and a phone or browser ${who} signed in on today still works.`
        : PIN_MESSAGES.pin_locked;
    case "pin_paused":
      return `Too many wrong referee PINs at this organisation: signing in with a PIN on a new device is paused for ${minutes(c.retryAfterSeconds)} minutes and the organiser has been told. A phone or browser you signed in on today still works.`;
    case "pin_busy":
      return `Too many PIN attempts from this network. Wait ${minutes(c.retryAfterSeconds)} minutes and try again.`;
    case "unknown_referee":
      return PIN_MESSAGES.unknown_referee;
    default:
      return REFUSAL_MESSAGE.unavailable;
  }
}

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
    // The PIN step names the referee (audit H1). Move Score 1.0.1 (one field) never does.
    const refereeId = combined ? null : typeof opts.refereeId === "string" && opts.refereeId ? opts.refereeId : null;
    if (!typedPin) {
      return {
        ok: false,
        error: opts.via === "app" ? PIN_MESSAGES.pin_required_legacy : PIN_MESSAGES.pin_required,
        reason: "pin_required",
        court: row.court_name,
        master,
        referees: await refereeChoices(row),
      };
    }
    const checked = await checkRefereePin(row, typedPin, { refereeId, ip: opts.ip ?? "unknown", deviceKey: opts.deviceKey ?? null }, now);
    if (!checked.ok) {
      if (checked.reason === "unavailable") return { ok: false, error: REFUSAL_MESSAGE.unavailable, reason: "unavailable" };
      if (checked.reason === "unknown_referee") {
        return { ok: false, error: pinMessage(checked), reason: "pin_required", court: row.court_name, master, referees: await refereeChoices(row) };
      }
      return { ok: false, error: pinMessage(checked), reason: checked.reason, retryAfterSeconds: checked.retryAfterSeconds, triesLeft: checked.triesLeft, court: row.court_name, master };
    }
    const sessionId = await startRefereeSession(row, checked.referee, {
      via: opts.via === "app" ? (combined || !refereeId ? "app_legacy" : "app") : "web",
      expiresAt: new Date(exp).toISOString(),
      installationId: opts.installationId ?? null,
      deviceHash: checked.deviceHash,
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
  /** The old court's code (organization_codes.id) the carry-over speaks for. */
  codeId: string;
}

/** What a carry-over may be made from: the credential the device had, and its earlier carries. */
type CarrySource = Pick<StaffPrincipal, "kind" | "codeId" | "orgId" | "role" | "referee" | "scopeTournamentId" | "scopeCourt" | "scopeMatchIds" | "scopeTournamentIds" | "tokenExpiresAt">;

/**
 * Whether this device scored a match (audit L2): the referee's own score events
 * (score_events.created_by "referee:<id>"), or the match's scoring lease held by one of
 * the device's ids (the app's verified installation, the browser's scoring id).
 */
async function deviceWorkedOn(matchId: string, refereeId: string | null, deviceIds: string[]): Promise<boolean> {
  if (refereeId) {
    const { data } = await db().from("score_events").select("id").eq("match_id", matchId).eq("created_by", `referee:${refereeId}`).limit(1);
    if (((data ?? []) as unknown[]).length) return true;
  }
  const ids = deviceIds.filter((d) => typeof d === "string" && d.length >= 8 && d.length <= 80);
  if (!ids.length) return false;
  const { data } = await db().from("scoring_leases").select("device_id").eq("match_id", matchId).in("device_id", ids).limit(1);
  return ((data ?? []) as unknown[]).length > 0;
}

/**
 * Switching courts is never blocked (owner's decision, 19 Oct 2026). When the
 * previous credential is a referee code and the device still holds unsent points
 * (`pending`) or an unfinished match (`open`) that the new credential does not
 * reach, the old code keeps reaching exactly those matches through a carry-over
 * token (`m` in src/lib/auth/staffToken.ts), never a new one.
 *
 * - Only matches this device worked on: its referee's score events or its scoring
 *   lease (deviceWorkedOn; audit L2), never every unfinished match of the old court.
 * - Earlier carries (`existing`: the browser's carry cookies, a second or third switch)
 *   are kept and re-checked, never dropped because the new switch carries nothing;
 *   matches of the same code are merged into one token (audit M1).
 * - A carry lapses by itself: a finished match drops out after CARRY_GRACE_MINUTES
 *   (src/lib/orgs/courtScope.ts), the token after CARRY_HOURS but never later than the
 *   token it came from nor the referee's sign-in row (audit L2), and revoking the old
 *   code ends it at once. A carry token is never a `previous` credential itself.
 */
export async function issueCarries(
  opts: {
    previous: StaffPrincipal | null;
    existing?: StaffPrincipal[];
    next: Reach;
    matches: { pending?: string[]; open?: string[] };
    deviceIds?: (string | null | undefined)[];
  },
  now = Date.now(),
): Promise<Carry[]> {
  const pending = new Set((opts.matches.pending ?? []).filter(isUuid));
  const deviceIds = (opts.deviceIds ?? []).filter((d): d is string => typeof d === "string");
  const byCode = new Map<string, { src: CarrySource; ids: string[]; exp: number }>();
  const capOf = (src: CarrySource) =>
    Math.min(now + CARRY_HOURS * 3600_000, src.tokenExpiresAt ?? now + CARRY_HOURS * 3600_000, src.referee?.sessionExpiresAt ?? Number.POSITIVE_INFINITY);
  const add = (src: CarrySource, id: string) => {
    const e = byCode.get(src.codeId!) ?? { src, ids: [], exp: capOf(src) };
    e.exp = Math.min(e.exp, capOf(src));
    if (!e.ids.includes(id) && e.ids.length < MAX_CARRY_MATCHES) e.ids.push(id);
    byCode.set(src.codeId!, e);
  };
  const stillNeeded = async (src: CarrySource, id: string) => {
    const scope = await resolveEntity({ match: id });
    if (!scope || !principalReaches(src, scope, now)) return false;
    if (principalReaches(opts.next, { ...scope }, now)) return false;
    // An unfinished match is carried while it is unfinished; one with unsent points, whatever the server says.
    return pending.has(id) || !FINISHED_STATUSES.has(scope.matchStatus ?? "");
  };

  // Earlier carries first (each already bound to the device when it was issued).
  for (const c of opts.existing ?? []) {
    if (c.kind !== "code" || !c.codeId || c.role !== "referee" || !c.scopeMatchIds?.length || c.orgId !== opts.next.orgId) continue;
    for (const id of c.scopeMatchIds) if (await stillNeeded(c, id)) add(c, id);
  }
  const prev = opts.previous;
  if (prev && prev.kind === "code" && prev.codeId && prev.role === "referee" && !prev.scopeMatchIds) {
    const ids = [...new Set([...pending, ...(opts.matches.open ?? []).filter(isUuid)])].slice(0, MAX_CARRY_MATCHES);
    for (const id of ids) {
      if (!(await stillNeeded(prev, id))) continue;
      if (!(await deviceWorkedOn(id, prev.referee?.id ?? null, deviceIds))) continue;
      add(prev, id);
    }
  }

  const out: Carry[] = [];
  for (const { src, ids, exp } of byCode.values()) {
    if (!ids.length || exp <= now + 60_000) continue;
    try {
      const who = src.referee ? { p: src.referee.id, s: src.referee.sessionId } : {};
      const token = signStaffToken({ v: 1, k: "c", c: src.codeId!, o: src.orgId, r: "referee", t: src.scopeTournamentId, m: ids, ...who, iat: now, exp }, staffSecret());
      out.push({ token, matchIds: ids, court: src.scopeCourt?.name ?? null, expiresAt: new Date(exp).toISOString(), codeId: src.codeId! });
    } catch (err) {
      console.error("staff sessions unavailable:", (err as Error).message);
      return [];
    }
  }
  return out.slice(0, MAX_WEB_CARRIES);
}

/** The newest carry of a switch made from `previous` (the app's answer has one). */
export async function issueCarry(
  previous: StaffPrincipal | null,
  next: Reach,
  matches: { pending?: string[]; open?: string[] },
  deviceIds: (string | null | undefined)[] = [],
  now = Date.now(),
): Promise<Carry | null> {
  if (!previous || previous.scopeMatchIds) return null;
  const all = await issueCarries({ previous, next, matches, deviceIds }, now);
  return all.find((c) => c.codeId === previous.codeId) ?? null;
}

/** At most this many carry-over cookies in a browser (one per earlier court). */
export const MAX_WEB_CARRIES = 3;

/** The carry-over cookies of a browser: one per earlier court, `mb_carry`, `mb_carry_2`, `mb_carry_3` (`__Host-` off localhost). */
export function carryCookieNames(host: string | null | undefined): string[] {
  const { secure } = staffCookieFor(host);
  const base = secure ? "__Host-mb_carry" : "mb_carry";
  return Array.from({ length: MAX_WEB_CARRIES }, (_, i) => (i === 0 ? base : `${base}_${i + 1}`));
}

export function carryCookieFor(host: string | null | undefined): { name: string; secure: boolean } {
  const { secure } = staffCookieFor(host);
  return { name: carryCookieNames(host)[0], secure };
}

/** Writes the browser's carry-over cookies: one per carry, the rest cleared. */
export async function setCarryCookies(carries: Carry[]) {
  const host = (await headers()).get("host");
  const { secure } = staffCookieFor(host);
  const store = await cookies();
  carryCookieNames(host).forEach((name, i) => {
    const c = carries[i];
    if (!c) store.set(name, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 });
    else store.set(name, c.token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: Math.max(60, Math.floor((Date.parse(c.expiresAt) - Date.now()) / 1000)) });
  });
}

/**
 * This request's carry-over credentials: the app's `X-Staff-Carry` header (up to
 * three tokens, comma-separated) and the browser's carry cookies. Only working
 * carry-over tokens (with their match list) count; anything else is ignored.
 */
export const currentCarries = cache(async (): Promise<StaffPrincipal[]> => {
  const h = await headers();
  const raw = (h.get("x-staff-carry") ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 3);
  const store = await cookies();
  const host = h.get("host");
  const names = [...carryCookieNames(host), ...(isLocalHostName(host) ? carryCookieNames("example.org") : [])];
  for (const name of names) {
    const v = store.get(name)?.value;
    if (v) raw.push(v);
  }
  const out: StaffPrincipal[] = [];
  for (const t of raw.slice(0, 6)) {
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
  // A carry-over token is not a sign-in of its own: it never ends the row it names.
  if (previous?.scopeMatchIds) return;
  if (!previous?.referee || carried) return;
  await endRefereeSession(previous.referee.sessionId, "replaced");
}

export { STAFF_APP_HOURS, STAFF_WEB_HOURS };
