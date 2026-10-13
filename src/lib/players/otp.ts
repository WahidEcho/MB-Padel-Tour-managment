/**
 * Phone one-time codes: the rules, without the database. Pure module, shared with
 * the app through move-score-app/src/core (it only needs OTP_LENGTH and
 * normalizeOneTimeCode).
 *
 * Six digits, ten minutes, five attempts. A verification can be answered once; a
 * wrong code costs an attempt; the last attempt used up closes it. The server keeps
 * only a keyed hash of the code (codeVault.hashOneTimeCode) and compares hashes in
 * constant time.
 */

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
/** After a successful check, how long the player has to pick which entries are theirs. */
export const OTP_CHOOSE_MS = 15 * 60_000;

/** `randomInt(n)` must return a uniformly random integer in [0, n), e.g. crypto.randomInt. */
export function newOneTimeCode(randomInt: (n: number) => number): string {
  let s = "";
  for (let i = 0; i < OTP_LENGTH; i++) s += String(randomInt(10));
  return s;
}

/** What was typed or pasted, as six western digits ("123 456", "١٢٣٤٥٦", "Your code is 123456"), or null. */
export function normalizeOneTimeCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 80) return null;
  const western = input.replace(/[٠-٩۰-۹]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c - (c >= 0x06f0 ? 0x06f0 : 0x0660));
  });
  const compact = western.replace(/[\s\-–—_.]/g, "");
  if (/^\d{6}$/.test(compact)) return compact;
  const hits = [...new Set([...western.matchAll(/(?:^|\D)(\d{3}[\s-]?\d{3})(?=\D|$)/g)].map((m) => m[1]!.replace(/\D/g, "")))];
  return hits.length === 1 ? hits[0]! : null;
}

export interface VerificationState {
  expires_at: string;
  attempts: number;
  consumed_at: string | null;
}

export type CheckVerdict = "open" | "expired" | "used" | "locked";

/** Whether a verification can still take an answer at `now`. */
export function verificationOpen(v: VerificationState, now = Date.now()): CheckVerdict {
  if (v.consumed_at) return "used";
  if (v.attempts >= OTP_MAX_ATTEMPTS) return "locked";
  if (Date.parse(v.expires_at) <= now) return "expired";
  return "open";
}

/** Whether a checked verification still allows picking entries (OTP_CHOOSE_MS after it was used). */
export function chooseOpen(v: Pick<VerificationState, "consumed_at">, now = Date.now()): boolean {
  return Boolean(v.consumed_at) && now - Date.parse(v.consumed_at!) <= OTP_CHOOSE_MS;
}
