import { createHash } from "node:crypto";
import { refundRateLimit, takeRateLimit, type RateLimitOptions } from "./ratelimit";
import { normalizeEventCode } from "./orgs/codes";

/**
 * Brake on guessing staff access codes (and Move Beyond's shared role passwords,
 * which arrive on the same path), shared by the web login and the app.
 *
 * Every attempt is counted **before** it is checked, atomically
 * (`takeRateLimit`: compare-and-set on request_counters), so a wave of
 * simultaneous guesses cannot all read the same count and slip through. An
 * attempt that turns out right is then **refunded**: a whole venue signs its
 * referees in with one shared event code, from one Wi-Fi address, and forty
 * right answers must never lock the forty-first referee out. A right answer is
 * no help to someone guessing, so it costs nothing in the end; every wrong one
 * stays counted.
 *
 * - Per address: generous, because a whole venue can share one mobile-network address.
 * - Per code prefix: the first four characters of what was typed (normalised,
 *   hashed, so no part of a code or password is ever stored in request_counters).
 *   A script spread over many addresses still meets this brake for any one code,
 *   while everyone else's codes, which start differently, are untouched.
 * - Per address, for anything that is not shaped like an event code (12
 *   characters of the code alphabet): those can only be shared-password guesses,
 *   and the shared passwords are far shorter on entropy than codes, so they get a
 *   much smaller allowance.
 *
 * Once a bucket is full, every attempt in it is refused (a right code too) until
 * the window ends. A refused attempt is not tried, so it is not counted against
 * the other buckets either (the address bucket is checked first): "40 wrong
 * guesses close a prefix" means 40 guesses that were tried, whatever else was
 * refused around them. The outcome depends only on the buckets' counts, never on
 * timing: every take is a compare-and-set (takeRateLimit). There is deliberately no platform-wide ceiling: one attacker
 * could otherwise lock every organisation's staff out of signing in. (Event codes
 * are 12 characters from a 31-symbol alphabet, ~7.9e17 possibilities; guessing
 * one is not a matter of volume a ceiling would change.) The email sign-in adds
 * its own per-email brake (src/lib/auth/limits.ts).
 */
export const STAFF_LOGIN_PER_IP = { limit: 20, windowSeconds: 15 * 60 };
export const STAFF_LOGIN_PER_PREFIX = { limit: 40, windowSeconds: 15 * 60 };
export const STAFF_LOGIN_NOT_A_CODE_PER_IP = { limit: 6, windowSeconds: 15 * 60 };

/** The bucket a typed code falls in: a short hash of its first four normalised characters. */
export function codePrefixKey(typed: string): string | null {
  const prefix = typed.toUpperCase().replace(/[\s\-–—_.]/g, "").slice(0, 4);
  if (!prefix) return null;
  return createHash("sha256").update(`mb-staff-prefix:v1:${prefix}`).digest("hex").slice(0, 16);
}

/** The buckets one attempt counts against. `typedCode` is omitted for the email sign-in. */
export function staffLoginBuckets(ip: string, typedCode?: string): RateLimitOptions[] {
  const bucket = typedCode ? codePrefixKey(typedCode) : null;
  const notACode = typedCode !== undefined && typedCode.trim() !== "" && !normalizeEventCode(typedCode.trim());
  return [
    { key: `staff-login:${ip}`, ...STAFF_LOGIN_PER_IP },
    ...(bucket ? [{ key: `staff-code:${bucket}`, ...STAFF_LOGIN_PER_PREFIX }] : []),
    ...(notACode ? [{ key: `staff-pass:${ip}`, ...STAFF_LOGIN_NOT_A_CODE_PER_IP }] : []),
  ];
}

export interface StaffLoginAttempt {
  allowed: boolean;
  retryAfterSeconds: number;
  /** Gives the attempt back (call it when the sign-in succeeded, or could not be checked at all). */
  refund: () => Promise<void>;
}

/**
 * Counts one attempt against the address (and the code's prefix) before it is
 * checked. Refused when any bucket is full; whatever was taken for a refused
 * attempt is given back, so being refused costs nothing more.
 */
export async function staffLoginAttempt(ip: string, typedCode?: string, client?: Parameters<typeof takeRateLimit>[1]): Promise<StaffLoginAttempt> {
  const taken: RateLimitOptions[] = [];
  const refund = async () => {
    await Promise.all(taken.splice(0).map((b) => refundRateLimit(b, client)));
  };
  for (const b of staffLoginBuckets(ip, typedCode)) {
    const r = await takeRateLimit(b, client);
    if (r.taken) taken.push(b);
    if (!r.allowed) {
      await refund();
      return { allowed: false, retryAfterSeconds: r.retryAfterSeconds, refund: async () => {} };
    }
  }
  return { allowed: true, retryAfterSeconds: 0, refund };
}
