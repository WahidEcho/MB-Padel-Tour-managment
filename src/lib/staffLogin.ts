import { createHash } from "node:crypto";
import { checkRateLimit } from "./ratelimit";

/**
 * Brake on guessing staff access codes, shared by the web login and the app.
 *
 * - Per address: generous, because a whole venue can share one mobile-network address.
 * - Per code prefix: the first four characters of what was typed (normalised,
 *   hashed, so no part of a code or password is ever stored in request_counters).
 *   A script spread over many addresses still meets this brake for any one code,
 *   while everyone else's codes, which start differently, are untouched.
 *
 * There is deliberately no platform-wide ceiling: one attacker could otherwise
 * lock every organisation's staff out of signing in. (Event codes are 12
 * characters from a 31-symbol alphabet, ~7.9e17 possibilities; guessing one is
 * not a matter of volume a ceiling would change.) The email sign-in adds its own
 * per-email brake (src/lib/auth/limits.ts).
 */
export const STAFF_LOGIN_PER_IP = { limit: 20, windowSeconds: 15 * 60 };
export const STAFF_LOGIN_PER_PREFIX = { limit: 40, windowSeconds: 15 * 60 };

/** The bucket a typed code falls in: a short hash of its first four normalised characters. */
export function codePrefixKey(typed: string): string | null {
  const prefix = typed.toUpperCase().replace(/[\s\-–—_.]/g, "").slice(0, 4);
  if (!prefix) return null;
  return createHash("sha256").update(`mb-staff-prefix:v1:${prefix}`).digest("hex").slice(0, 16);
}

export async function staffLoginAllowed(ip: string, typedCode?: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const perIp = await checkRateLimit({ key: `staff-login:${ip}`, ...STAFF_LOGIN_PER_IP });
  if (!perIp.allowed) return { allowed: false, retryAfterSeconds: perIp.retryAfterSeconds };
  const bucket = typedCode ? codePrefixKey(typedCode) : null;
  if (!bucket) return { allowed: true, retryAfterSeconds: 0 };
  const perPrefix = await checkRateLimit({ key: `staff-code:${bucket}`, ...STAFF_LOGIN_PER_PREFIX });
  return { allowed: perPrefix.allowed, retryAfterSeconds: perPrefix.retryAfterSeconds };
}
