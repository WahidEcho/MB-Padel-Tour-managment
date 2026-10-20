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
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from "node:crypto";

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

function sealKey(pepper: string): Buffer {
  return createHmac("sha256", pepper).update("mb-event-code-seal:v1").digest();
}

/**
 * Court codes only (migration 0034): the code sealed (AES-256-GCM, "v1.<iv>.<tag>.<body>")
 * so the organiser can print the court's QR sheet again. Only this server can open it.
 */
export function sealEventCode(normalized: string, pepper = eventCodePepper()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey(pepper), iv);
  const body = Buffer.concat([c.update(normalized, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** What was sealed, or null when it is not a seal made with this pepper. */
function openSealed(sealed: string | null | undefined, pepper?: string): string | null {
  if (!sealed || sealed.length > 600) return null;
  try {
    const [v, iv, tag, body] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !body) return null;
    const authTag = Buffer.from(tag, "base64url");
    if (authTag.length !== 16) return null;
    const d = createDecipheriv("aes-256-gcm", sealKey(pepper ?? eventCodePepper()), Buffer.from(iv, "base64url"), { authTagLength: 16 });
    d.setAuthTag(authTag);
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** The sealed code (normalised), or null when it is not a seal made with this pepper. */
export function openEventCode(sealed: string | null | undefined, pepper?: string): string | null {
  const code = openSealed(sealed, pepper);
  return code ? normalizeEventCode(code) : null;
}

/**
 * The web PIN step's cookie (`__Host-mb_pin_code`, src/app/login/page.tsx): the code
 * sealed together with when it was typed (audit L7), so the server itself refuses it
 * after PIN_STEP_SECONDS whatever the browser does with the cookie's max-age.
 */
export const PIN_STEP_SECONDS = 5 * 60;

export function sealPinStep(normalized: string, nowMs = Date.now(), pepper = eventCodePepper()): string {
  return sealEventCode(`pin1:${normalized}:${nowMs}`, pepper);
}

/** The code of a PIN-step cookie made in the last PIN_STEP_SECONDS; null otherwise (expired, forged, a bare sealed code). */
export function openPinStep(sealed: string | null | undefined, nowMs = Date.now(), pepper?: string): string | null {
  const raw = openSealed(sealed, pepper);
  const m = raw ? /^pin1:([A-Z0-9]{12}):(\d{10,16})$/.exec(raw) : null;
  if (!m) return null;
  const at = Number(m[2]);
  if (!(at <= nowMs + 60_000) || nowMs - at > PIN_STEP_SECONDS * 1000) return null;
  return normalizeEventCode(m[1]);
}
