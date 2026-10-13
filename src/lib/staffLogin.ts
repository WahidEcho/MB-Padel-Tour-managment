import { createHash } from "node:crypto";
import { peekRateLimit, recordRateLimitHit } from "./ratelimit";

/**
 * Brake on guessing staff access codes, shared by the web login and the app.
 *
 * Only **failed** attempts count: a whole venue signs its referees in with one
 * shared event code, from one Wi-Fi address, and forty right answers must never
 * lock the forty-first referee out. A right answer is no help to someone
 * guessing, so it costs nothing; every wrong one is counted.
 *
 * - Per address: generous, because a whole venue can share one mobile-network address.
 * - Per code prefix: the first four characters of what was typed (normalised,
 *   hashed, so no part of a code or password is ever stored in request_counters).
 *   A script spread over many addresses still meets this brake for any one code,
 *   while everyone else's codes, which start differently, are untouched.
 *
 * Once a bucket is full, every attempt in it is refused (a right code too) until
 * the window ends. There is deliberately no platform-wide ceiling: one attacker
 * could otherwise lock every organisation's staff out of signing in. (Event codes
 * are 12 characters from a 31-symbol alphabet, ~7.9e17 possibilities; guessing
 * one is not a matter of volume a ceiling would change.) The email sign-in adds
 * its own per-email brake (src/lib/auth/limits.ts).
 */
export const STAFF_LOGIN_PER_IP = { limit: 20, windowSeconds: 15 * 60 };
export const STAFF_LOGIN_PER_PREFIX = { limit: 40, windowSeconds: 15 * 60 };

/** The bucket a typed code falls in: a short hash of its first four normalised characters. */
export function codePrefixKey(typed: string): string | null {
  const prefix = typed.toUpperCase().replace(/[\s\-–—_.]/g, "").slice(0, 4);
  if (!prefix) return null;
  return createHash("sha256").update(`mb-staff-prefix:v1:${prefix}`).digest("hex").slice(0, 16);
}

function buckets(ip: string, typedCode?: string) {
  const bucket = typedCode ? codePrefixKey(typedCode) : null;
  return [
    { key: `staff-login:${ip}`, ...STAFF_LOGIN_PER_IP },
    ...(bucket ? [{ key: `staff-code:${bucket}`, ...STAFF_LOGIN_PER_PREFIX }] : []),
  ];
}

/** Whether this address (and this code's prefix) may try again. Counts nothing. */
export async function staffLoginAllowed(ip: string, typedCode?: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  for (const b of buckets(ip, typedCode)) {
    const r = await peekRateLimit(b);
    if (!r.allowed) return { allowed: false, retryAfterSeconds: r.retryAfterSeconds };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Counts one failed attempt against the address and the code's prefix. */
export async function staffLoginFailed(ip: string, typedCode?: string): Promise<void> {
  for (const b of buckets(ip, typedCode)) await recordRateLimitHit(b);
}
