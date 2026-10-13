import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { Role } from "./types";
import { safeEqual } from "./auth/safeEqual";
import { permissionRole, type OrgRole } from "./orgs/roles";

/*
 * The shared role passwords (ADMIN_PASSWORD …) and their `role.expiry.signature`
 * tokens, signed with AUTH_SECRET. Since organisations (migration 0023) they only
 * ever reach the Move Beyond organisation (src/lib/auth/staff.ts), and they are
 * retired at the end of Phase 0.5. Personal accounts and event codes use the
 * `mbs1.` tokens in src/lib/auth/staffToken.ts. Who is signed in: currentStaff()
 * in src/lib/auth/staff.ts; guards: src/lib/guard.ts.
 */

const COOKIE_NAME = "mb_session";
const SESSION_HOURS = 24;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET must be set");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** The app keeps a staff session for a week: a 24-hour token can expire mid-match. */
export const APP_SESSION_HOURS = 24 * 7;

export function createSessionToken(role: Role, hours = SESSION_HOURS): string {
  const payload = `${role}.${Date.now() + hours * 3600_000}`;
  return `${payload}.${sign(payload)}`;
}

/** The role of a valid legacy shared-password token (Move Beyond only; see staff.ts). */
export function verifySessionToken(token: string | undefined): Role | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(payload);
  if (!safeEqual(sig, expected)) return null;
  const [role, exp] = payload.split(".");
  if (Number(exp) < Date.now()) return null;
  if (!["admin", "manager", "referee", "operator"].includes(role)) return null;
  return role as Role;
}

export function roleForPassword(password: string): Role | null {
  const map: [string | undefined, Role][] = [
    [process.env.ADMIN_PASSWORD, "admin"],
    [process.env.MANAGER_PASSWORD, "manager"],
    [process.env.REFEREE_PASSWORD, "referee"],
    [process.env.OPERATOR_PASSWORD, "operator"],
  ];
  // Compare digests, so every comparison takes the same time whatever the input.
  const given = createHash("sha256").update(password).digest();
  let found: Role | null = null;
  for (const [pw, role] of map) {
    if (!pw) continue;
    if (timingSafeEqual(given, createHash("sha256").update(pw).digest()) && !found) found = role;
  }
  return found;
}

/** The token from an `Authorization: Bearer …` header, as the app sends it. */
export function bearerToken(h: Headers): string | undefined {
  const v = h.get("authorization");
  if (!v || !v.toLowerCase().startsWith("bearer ")) return undefined;
  return v.slice(7).trim() || undefined;
}

/**
 * The web staff cookie. `__Host-` makes the browser refuse it unless it is Secure,
 * host-only and path /, so no other subdomain of the site can set or shadow it
 * (cookie tossing). A localhost development server has no HTTPS: there, and only
 * there, the cookie is the plain `mb_session` without Secure.
 */
export const HOST_COOKIE_NAME = "__Host-mb_session";

export function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const name = host.toLowerCase().replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name.endsWith(".localhost");
}

/** The cookie a sign-in on this host sets. */
export function staffCookieFor(host: string | null | undefined): { name: string; secure: boolean } {
  return isLocalHost(host) ? { name: COOKIE_NAME, secure: false } : { name: HOST_COOKIE_NAME, secure: true };
}

/** The cookies a request on this host is read from: off localhost, only the `__Host-` one. */
export function staffCookieNames(host: string | null | undefined): string[] {
  return isLocalHost(host) ? [HOST_COOKIE_NAME, COOKIE_NAME] : [HOST_COOKIE_NAME];
}

export async function clearSessionCookie() {
  const store = await cookies();
  // A __Host- cookie is only replaced by a Set-Cookie with the same Secure, path /.
  store.set(HOST_COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 });
  store.set(COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

// Permission matrix (spec §4.4). Manager has admin-level tournament ops.
const PERMISSIONS = {
  manage_tournament: ["admin", "manager"],
  clone_tournament: ["admin", "manager"],
  manage_teams: ["admin", "manager"],
  check_in: ["admin", "manager", "referee"],
  manage_groups: ["admin", "manager"],
  generate_matches: ["admin", "manager"],
  score_match: ["admin", "manager", "referee"],
  edit_bracket: ["admin", "manager", "referee"],
  control_screen: ["admin", "manager", "operator"],
  // Adding a wall on the night is the operator's job; removing one, which can
  // blank a TV somebody is watching, is not.
  manage_screens: ["admin", "manager", "operator"],
  delete_screen: ["admin", "manager"],
  export: ["admin", "manager"],
  // Friendly sessions. Referees may check players in on arrival, matching the
  // existing `check_in` permission, but cannot alter sessions or profiles.
  manage_sessions: ["admin", "manager"],
  manage_players: ["admin", "manager"],
  manage_seasons: ["admin", "manager"],
  check_in_session: ["admin", "manager", "referee"],
  // Announcements: email and WhatsApp to players (Admin → Announcements).
  send_messages: ["admin", "manager"],
  // Event codes for referees and TV operators (Admin → Event codes).
  manage_codes: ["admin", "manager"],
  // Platform-wide app settings (Admin → Discover): Discover order and feature flags.
  // The role alone is not enough: guard.ts also requires a platform admin.
  manage_platform: ["admin"],
} satisfies Record<string, Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Whether a role may do an action. An organisation's owner holds every admin permission. */
export function can(role: Role | OrgRole | null | undefined, action: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[action] as Role[] | undefined)?.includes(permissionRole(role)) ?? false;
}

export const COOKIE = COOKIE_NAME;
