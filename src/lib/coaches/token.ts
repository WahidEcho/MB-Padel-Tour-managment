/**
 * Coach tokens (migration 0037): what a team's code is exchanged for, kept by the app
 * (Authorization: Bearer) or the browser (an HttpOnly cookie). Server-only (node:crypto);
 * no Next.js APIs, so it is unit-tested directly.
 *
 *   mbc1.<base64url JSON payload>.<base64url HMAC-SHA256 of "mbc1.<payload>">
 *
 * Signed with a key derived from STAFF_SESSION_SECRET for coaches alone, and with its own
 * prefix: a coach token is never a staff token (those start "mbs1.", and the staff side
 * refuses anything else) nor a user's session (the user side refuses this prefix too).
 * A valid signature only says the server once let this device in; the code (revoked,
 * expired) and the sign-in (ended) are read from the database on every request.
 */
import { createHmac } from "node:crypto";
import { safeEqual } from "../auth/safeEqual";
import { staffSecret } from "../auth/staffToken";

export const COACH_TOKEN_PREFIX = "mbc1.";

/** A web sign-in lasts a day; the app keeps a coach signed in for a week (never past the code's expiry). */
export const COACH_WEB_HOURS = 24;
export const COACH_APP_HOURS = 24 * 7;
const MAX_LIFETIME_MS = 8 * 24 * 3600_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export interface CoachTokenPayload {
  v: 1;
  k: "coach";
  /** coach_codes.id */
  c: string;
  /** organizations.id */
  o: string;
  /** teams.id: the one team this token reaches. */
  tm: string;
  /** coach_sessions.id */
  s: string;
  iat: number;
  exp: number;
}

/** The coach signing key: its own, derived from the staff session secret. Fails closed in production like it. */
export function coachSecret(env: Record<string, string | undefined> = process.env): string {
  return createHmac("sha256", staffSecret(env)).update("mb-coach-session:v1").digest("base64url");
}

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function signCoachToken(payload: CoachTokenPayload, secret: string): string {
  const body = `${COACH_TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${mac(body, secret)}`;
}

/** The payload of a well-formed, correctly signed, unexpired coach token; null for anything else. */
export function verifyCoachToken(token: string | null | undefined, secret: string, now = Date.now()): CoachTokenPayload | null {
  if (typeof token !== "string" || token.length > 1500 || !token.startsWith(COACH_TOKEN_PREFIX)) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= COACH_TOKEN_PREFIX.length) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), mac(body, secret))) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(Buffer.from(body.slice(COACH_TOKEN_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!p || typeof p !== "object" || p.v !== 1 || p.k !== "coach") return null;
  const { iat, exp } = p;
  if (typeof iat !== "number" || typeof exp !== "number") return null;
  if (exp <= now || iat > now + 60_000 || exp - iat > MAX_LIFETIME_MS) return null;
  if (!isUuid(p.c) || !isUuid(p.o) || !isUuid(p.tm) || !isUuid(p.s)) return null;
  return { v: 1, k: "coach", c: p.c, o: p.o, tm: p.tm, s: p.s, iat, exp };
}

export function isCoachTokenShaped(token: string | null | undefined): boolean {
  return typeof token === "string" && token.startsWith(COACH_TOKEN_PREFIX);
}
