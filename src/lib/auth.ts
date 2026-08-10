import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
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

export function createSessionToken(role: Role): string {
  const payload = `${role}.${Date.now() + SESSION_HOURS * 3600_000}`;
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
  for (const [pw, role] of map) {
    if (pw && password === pw) return role;
  }
  return null;
}

export async function currentRole(): Promise<Role | null> {
  const store = await cookies();
  return verifySessionToken(store.get(COOKIE_NAME)?.value);
}

export async function setSessionCookie(role: Role) {
  const store = await cookies();
  store.set(COOKIE_NAME, createSessionToken(role), {
    httpOnly: true,
    sameSite: "lax",
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
  export: ["admin", "manager"],
  // Friendly sessions. Referees may check players in on arrival, matching the
  // existing `check_in` permission, but cannot alter sessions or profiles.
  manage_sessions: ["admin", "manager"],
  manage_players: ["admin", "manager"],
  manage_seasons: ["admin", "manager"],
  check_in_session: ["admin", "manager", "referee"],
};

export function can(role: Role | null, action: keyof typeof PERMISSIONS): boolean {
  if (!role) return false;
  return PERMISSIONS[action]?.includes(role) ?? false;
}

export const COOKIE = COOKIE_NAME;
