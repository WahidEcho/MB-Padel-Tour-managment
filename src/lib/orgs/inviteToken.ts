/**
 * Staff invite tokens. Server-only (node:crypto); no database or Next.js, so it is
 * unit-tested directly.
 *
 * A link is `<site>/invite?t=<token>`, the token 32 random bytes (base64url, 43
 * characters). Only HMAC-SHA256 of the token under the server's pepper
 * (EVENT_CODE_PEPPER, domain-separated from event codes) is stored: a copy of the
 * table alone cannot be turned back into a working link, and only this server
 * can say which stored row a link belongs to. Single use, bound to one email,
 * seven days (src/lib/orgs/invites.ts).
 */
import { createHmac, randomBytes } from "node:crypto";
import { eventCodePepper } from "./codes";

export const INVITE_DAYS = 7;
export const INVITE_TTL_MS = INVITE_DAYS * 86_400_000;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Whether a value can be an invite token at all (checked before any lookup). */
export function isInviteTokenShaped(t: unknown): t is string {
  return typeof t === "string" && TOKEN.test(t);
}

/** What is stored for a token: HMAC-SHA256 (hex) under the pepper. */
export function hashInviteToken(token: string, pepper = eventCodePepper()): string {
  return createHmac("sha256", pepper).update(`mb-invite:v1:${token}`).digest("hex");
}

/** "someone@example.com" → "so•••@example.com", for pages that must not echo a whole address. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "•••";
  const name = email.slice(0, at);
  return `${name.slice(0, Math.min(2, name.length))}•••${email.slice(at)}`;
}
