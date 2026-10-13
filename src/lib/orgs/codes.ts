/**
 * Event codes: what a referee or TV operator types instead of a password.
 * Server-only (node:crypto).
 *
 * A code is 12 characters from a 31-symbol alphabet with the look-alikes left
 * out (no 0/O, 1/I/L), shown in groups of four: "K7QM-W3XT-9HRP". That is
 * 31^12 ≈ 7.9e17 possibilities; lookups are rate-limited and only an
 * HMAC-SHA256 of the normalised code, keyed with a server-side pepper
 * (EVENT_CODE_PEPPER), is stored: neither the database nor a log ever holds a
 * code that works, and a copy of the table alone cannot be searched for codes
 * offline without the pepper too.
 */
import { createHmac, randomInt } from "node:crypto";

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 12;

/** A fresh, uniformly random code (unformatted). */
export function generateEventCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * The code as typed, made comparable: upper case, separators and spaces dropped.
 * Null when it cannot be an event code (wrong length or a symbol outside the alphabet).
 */
export function normalizeEventCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const s = input.toUpperCase().replace(/[\s\-–—_.]/g, "");
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/**
 * The pepper event-code hashes are keyed with. Required in production (32+
 * characters, never in the database); development and tests derive one from
 * AUTH_SECRET so a checkout runs without another variable. Changing it makes
 * every existing code stop working (issue new ones).
 */
export function eventCodePepper(env: Record<string, string | undefined> = process.env): string {
  const p = env.EVENT_CODE_PEPPER;
  if (p && p.length >= 32) return p;
  if (env.NODE_ENV === "production") throw new Error("EVENT_CODE_PEPPER must be set (32+ characters) in production");
  return createHmac("sha256", env.AUTH_SECRET ?? "mb-dev-only").update("mb-event-code-pepper:v1").digest("base64url");
}

/**
 * What is stored: HMAC-SHA256 (hex) of the normalised code under the pepper.
 * Still 64 hex characters, so the column and its check constraint are unchanged.
 */
export function hashEventCode(normalized: string, pepper = eventCodePepper()): string {
  return createHmac("sha256", pepper).update(`mb-event-code:v1:${normalized}`).digest("hex");
}

/** "K7QMW3XT9HRP" → "K7QM-W3XT-9HRP". */
export function formatEventCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}
