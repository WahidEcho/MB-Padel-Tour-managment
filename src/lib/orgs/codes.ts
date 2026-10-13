/**
 * Event codes: what a referee or TV operator types instead of a password.
 * Server-only (node:crypto).
 *
 * A code is 12 characters from a 31-symbol alphabet with the look-alikes left
 * out (no 0/O, 1/I/L), shown in groups of four: "K7QM-W3XT-9HRP". That is
 * 31^12 ≈ 7.9e17 possibilities; lookups are rate-limited and only the SHA-256
 * of the normalised code is stored, so neither the database nor a log ever holds
 * a code that works.
 */
import { createHash, randomInt } from "node:crypto";

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

/** What is stored: SHA-256 (hex) of the normalised code, under a fixed domain prefix. */
export function hashEventCode(normalized: string): string {
  return createHash("sha256").update(`mb-event-code:v1:${normalized}`).digest("hex");
}

/** "K7QMW3XT9HRP" → "K7QM-W3XT-9HRP". */
export function formatEventCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}
