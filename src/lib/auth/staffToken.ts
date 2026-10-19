/**
 * Organisation staff tokens: the signed `{user, org, role, exp}` the server
 * issues after it has checked a person's Supabase session (or an event code).
 * Server-only (node:crypto); no Next.js APIs, so it is unit-tested directly.
 *
 *   mbs1.<base64url JSON payload>.<base64url HMAC-SHA256 of "mbs1.<payload>">
 *
 * The `mbs1.` prefix keeps staff tokens and user tokens (Supabase JWTs, which
 * start "eyJ") from ever being taken for one another: the staff side refuses
 * anything without the prefix, the user side refuses anything with it.
 *
 * A valid signature only says who the server once let in. Whether the person is
 * still a member, the code still live and the organisation still approved is
 * read from the database on every request (src/lib/auth/staff.ts).
 *
 * The shared role passwords of the Move Beyond organisation keep their older
 * format (`role.expiry.signature`, signed with AUTH_SECRET; src/lib/auth.ts)
 * until they are retired at the end of Phase 0.5.
 */
import { createHmac } from "node:crypto";
import { safeEqual } from "./safeEqual";
import { isCodeRole, isOrgRole, isUuid, type OrgRole } from "../orgs/roles";

export const STAFF_TOKEN_PREFIX = "mbs1.";

/** A web staff session lasts a day; the app keeps a code session for a week (a day can end mid-match). */
export const STAFF_WEB_HOURS = 24;
export const STAFF_APP_HOURS = 24 * 7;
const MAX_LIFETIME_MS = 8 * 24 * 3600_000;

/** At most this many matches in a carry-over token (`m`). */
export const MAX_CARRY_MATCHES = 25;

/**
 * Code tokens may carry, besides the code (`c`):
 * - `m`: a carry-over token (court codes, migration 0034). After the referee
 *   switched courts, the old court's code keeps reaching only these matches (the
 *   ones the phone still had unsent points or an unfinished match on), never a
 *   new one. Absent on every ordinary code token.
 * - reserved for the referee PIN (planned): `p`, the signed-in referee's id, so the
 *   server knows which referee is on which court. Not read or written yet; a token
 *   with any unknown field is still verified on the fields it knows.
 */
export type StaffTokenPayload =
  | { v: 1; k: "m"; u: string; o: string; r: OrgRole; iat: number; exp: number }
  | { v: 1; k: "c"; c: string; o: string; r: "referee" | "operator"; t: string | null; m?: string[]; iat: number; exp: number };

/** The secret new staff tokens are signed with. Fails closed in production. */
export function staffSecret(env: Record<string, string | undefined> = process.env): string {
  const s = env.STAFF_SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (env.NODE_ENV === "production") {
    throw new Error("STAFF_SESSION_SECRET must be set (32+ characters) in production");
  }
  // Development and tests only: derived from AUTH_SECRET so a local checkout runs
  // without one more variable. Never reached in production.
  if (!env.AUTH_SECRET) throw new Error("STAFF_SESSION_SECRET or AUTH_SECRET must be set");
  return createHmac("sha256", env.AUTH_SECRET).update("mb-staff-session:v1").digest("base64url");
}

function mac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signStaffToken(payload: StaffTokenPayload, secret: string): string {
  const body = `${STAFF_TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${mac(body, secret)}`;
}

/** The payload of a well-formed, correctly signed, unexpired staff token; null for anything else. */
export function verifyStaffToken(token: string | null | undefined, secret: string, now = Date.now()): StaffTokenPayload | null {
  if (typeof token !== "string" || token.length > 2000 || !token.startsWith(STAFF_TOKEN_PREFIX)) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= STAFF_TOKEN_PREFIX.length) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = mac(body, secret);
  if (!safeEqual(sig, expected)) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(Buffer.from(body.slice(STAFF_TOKEN_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!p || typeof p !== "object" || p.v !== 1) return null;
  const iat = p.iat, exp = p.exp;
  if (typeof iat !== "number" || typeof exp !== "number") return null;
  if (exp <= now || iat > now + 60_000 || exp - iat > MAX_LIFETIME_MS) return null;
  if (!isUuid(p.o)) return null;
  if (p.k === "m") {
    if (!isUuid(p.u) || !isOrgRole(p.r)) return null;
    return { v: 1, k: "m", u: p.u, o: p.o, r: p.r, iat, exp };
  }
  if (p.k === "c") {
    if (!isUuid(p.c) || !isCodeRole(p.r)) return null;
    if (p.t !== null && !isUuid(p.t)) return null;
    if (p.m !== undefined) {
      if (!Array.isArray(p.m) || p.m.length === 0 || p.m.length > MAX_CARRY_MATCHES || !p.m.every((x) => isUuid(x))) return null;
      return { v: 1, k: "c", c: p.c, o: p.o, r: p.r, t: p.t as string | null, m: p.m as string[], iat, exp };
    }
    return { v: 1, k: "c", c: p.c, o: p.o, r: p.r, t: p.t as string | null, iat, exp };
  }
  return null;
}

const LEGACY_SHAPE = /^(admin|manager|referee|operator)\.\d{10,16}\.[A-Za-z0-9_-]{43}$/;

/**
 * Whether a bearer value is a staff credential of either format. The user-token
 * check refuses these outright, so a staff token can never pass as a user's.
 */
export function isStaffTokenShaped(token: string | null | undefined): boolean {
  return typeof token === "string" && (token.startsWith(STAFF_TOKEN_PREFIX) || LEGACY_SHAPE.test(token));
}
