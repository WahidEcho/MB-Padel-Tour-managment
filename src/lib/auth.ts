import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cookies, headers } from "next/headers";
import type { Role } from "./types";

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

export function verifySessionToken(token: string | undefined): Role | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
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

export async function currentRole(): Promise<Role | null> {
  // The app has no cookie jar for our domain: it sends the same signed token as a
  // bearer header. A token that is not ours (a user's Supabase session) simply
  // fails the signature check and falls through to the cookie.
  const fromHeader = verifySessionToken(bearerToken(await headers()));
  if (fromHeader) return fromHeader;
  const store = await cookies();
  return verifySessionToken(store.get(COOKIE_NAME)?.value);
}

export async function setSessionCookie(role: Role) {
  const store = await cookies();
  store.set(COOKIE_NAME, createSessionToken(role), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

// Permission matrix (spec §4.4). Manager has admin-level tournament ops.
const PERMISSIONS: Record<string, Role[]> = {
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
};

export function can(role: Role | null, action: keyof typeof PERMISSIONS): boolean {
  if (!role) return false;
  return PERMISSIONS[action]?.includes(role) ?? false;
}

export const COOKIE = COOKIE_NAME;
