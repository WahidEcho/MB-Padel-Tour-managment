/**
 * Staff guards for pages, server actions and API routes.
 *
 * Every guard reads the staff principal fresh (src/lib/auth/staff.ts: membership,
 * code and organisation status are re-checked in the database on every request)
 * and every guard that names a row resolves that row's organisation from the row
 * itself (src/lib/orgs/scope.ts). A row of another organisation and a row that
 * does not exist get the same answer: "Not found" (actions), notFound() (pages),
 * 404 { error: "Not found" } (routes).
 *
 * src/lib/adminGuards.test.ts fails the build when an admin action, page or
 * staff route reaches data without one of these.
 */
import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { staffCan, type Permission } from "./auth";
import { currentCarries, currentStaffResolution, REFUSAL_MESSAGE, type StaffPrincipal, type StaffResolution } from "./auth/staff";
import { entityInScope, isScopedCode, type EntityRef, type EntityScope } from "./orgs/scope";
import type { Role } from "./types";

export const NOT_FOUND = "Not found";
export const NOT_ALLOWED = "Not allowed";

export type { StaffPrincipal, EntityRef, EntityScope };

export interface ScopedStaff {
  staff: StaffPrincipal;
  scope: EntityScope;
}

/**
 * The principal that reaches a row: the signed-in one, or, for a match only, a
 * carry-over credential of the same request (the old court's code after switching
 * courts, for a match the phone still holds; src/lib/auth/staff.ts issueCarry).
 */
async function reaching(staff: StaffPrincipal, ref: EntityRef, action?: Permission): Promise<ScopedStaff | null> {
  const scope = await entityInScope(staff, ref);
  if (scope) return { staff, scope };
  if (!("match" in ref)) return null;
  for (const carry of await currentCarries()) {
    if (action && !staffCan(carry, action)) continue;
    const s = await entityInScope(carry, ref);
    if (s) return { staff: carry, scope: s };
  }
  return null;
}

function loginRedirect(nextUrl: string, r: StaffResolution): never {
  const reason = !r.ok && r.reason !== "signed_out" ? `&error=${r.reason}` : "";
  redirect(`/login?next=${encodeURIComponent(nextUrl)}${reason}`);
}

/* ---------------- pages: redirect to the login, or 404 ---------------- */

/** Page guard: the signed-in staff principal with one of the roles, or a redirect to the login. */
export async function requireStaff(roles: Role[], nextUrl: string): Promise<StaffPrincipal> {
  const r = await currentStaffResolution();
  if (!r.ok || !roles.includes(r.staff.role)) loginRedirect(nextUrl, r);
  return r.staff;
}

/** Page guard returning only the role (layouts that show it). */
export async function requireRole(roles: Role[], nextUrl: string): Promise<Role> {
  return (await requireStaff(roles, nextUrl)).role;
}

/** Page guard for one row: the principal must reach it, else the page is a 404. */
export async function requireEntityPage(ref: EntityRef, roles: Role[], nextUrl: string): Promise<ScopedStaff> {
  const staff = await requireStaff(roles, nextUrl);
  const hit = await reaching(staff, ref);
  if (!hit) notFound();
  return hit;
}

export function requireTournamentPage(tournamentId: string, roles: Role[], nextUrl: string): Promise<ScopedStaff> {
  return requireEntityPage({ tournament: tournamentId }, roles, nextUrl);
}

/** Page guard for Move Beyond's platform pages. */
export async function requirePlatformPage(nextUrl: string): Promise<StaffPrincipal> {
  const staff = await requireStaff(["admin"], nextUrl);
  if (!staff.platformAdmin) notFound();
  return staff;
}

/* ---------------- server actions: throw ---------------- */

async function staffFor(action: Permission): Promise<StaffPrincipal> {
  const r = await currentStaffResolution();
  if (!r.ok) throw new Error(r.reason === "signed_out" ? NOT_ALLOWED : REFUSAL_MESSAGE[r.reason]);
  // Members and the organisation's profile: personal accounts only, never a shared password.
  if (!staffCan(r.staff, action)) throw new Error(NOT_ALLOWED);
  return r.staff;
}

/**
 * Organisation-level actions that touch no existing row (create a tournament, a
 * season, a code): the principal, whose orgId the action stamps on what it creates.
 * Never use it for an action that names a row — use requireScopedPermission.
 */
export async function requireStaffPermission(action: Permission): Promise<StaffPrincipal> {
  const staff = await staffFor(action);
  // A code scoped to one tournament (or one court) acts inside it only.
  if (isScopedCode(staff)) throw new Error(NOT_ALLOWED);
  return staff;
}

/** The principal, when it acts for exactly this organisation with this permission. */
export async function requireOrgPermission(orgId: string, action: Permission): Promise<StaffPrincipal> {
  const staff = await staffFor(action);
  if (staff.orgId !== orgId || isScopedCode(staff)) throw new Error(NOT_FOUND);
  return staff;
}

/** The principal and the row's scope, when the principal may do `action` to that row. */
export async function requireScopedPermission(action: Permission, ref: EntityRef): Promise<ScopedStaff> {
  const staff = await staffFor(action);
  // A court code's actions are its court's matches only (no check-in, bracket or tournament tools).
  if (staff.scopeCourt && !("match" in ref)) throw new Error(NOT_FOUND);
  const hit = await reaching(staff, ref, action);
  if (!hit) throw new Error(NOT_FOUND);
  return hit;
}

export function requireTournamentPermission(action: Permission, tournamentId: string): Promise<ScopedStaff> {
  return requireScopedPermission(action, { tournament: tournamentId });
}

/** Move Beyond's platform settings: a platform admin only. */
export async function requirePlatformPermission(): Promise<StaffPrincipal> {
  const staff = await staffFor("manage_platform");
  if (!staff.platformAdmin) throw new Error(NOT_ALLOWED);
  return staff;
}

/* ---------------- API routes: a response instead of a throw ---------------- */

const NO_STORE = { "Cache-Control": "private, no-store" };

export type RouteStaff =
  | { ok: true; staff: StaffPrincipal; scope: EntityScope | null }
  | { ok: false; response: NextResponse };

/**
 * Route guard. 401 with the reason when the credential is missing, revoked or
 * expired (the app keeps its offline queue and asks for a new code); 403 when the
 * role lacks the permission; 404 "Not found" when the row does not exist or is
 * not the principal's.
 */
export async function staffRoute(action: Permission, ref?: EntityRef): Promise<RouteStaff> {
  const r = await currentStaffResolution();
  if (!r.ok) {
    return { ok: false, response: NextResponse.json({ error: REFUSAL_MESSAGE[r.reason], code: r.reason }, { status: 401, headers: NO_STORE }) };
  }
  if (!staffCan(r.staff, action)) {
    return { ok: false, response: NextResponse.json({ error: NOT_ALLOWED }, { status: 403, headers: NO_STORE }) };
  }
  if (!ref) {
    if (isScopedCode(r.staff) && action !== "score_match" && action !== "control_screen") {
      return { ok: false, response: NextResponse.json({ error: NOT_ALLOWED }, { status: 403, headers: NO_STORE }) };
    }
    return { ok: true, staff: r.staff, scope: null };
  }
  const hit = await reaching(r.staff, ref, action);
  if (!hit) return { ok: false, response: NextResponse.json({ error: NOT_FOUND }, { status: 404, headers: NO_STORE }) };
  return { ok: true, staff: hit.staff, scope: hit.scope };
}

/** For read routes that serve everyone but show staff more: the principal only when it reaches the row. */
export async function staffReaching(ref: EntityRef, action: Permission): Promise<StaffPrincipal | null> {
  const r = await currentStaffResolution().catch(() => null);
  if (!r?.ok || !staffCan(r.staff, action)) return null;
  return (await reaching(r.staff, ref, action))?.staff ?? null;
}
