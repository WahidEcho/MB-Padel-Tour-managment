/**
 * Staff invite tokens. Server-only (node:crypto); no database or Next.js, so it is
 * unit-tested directly.
 *
 * A link is `<site>/invite/open#t=<token>`, the token 32 random bytes (base64url, 43
 * characters). Only HMAC-SHA256 of the token under the server's pepper
 * (EVENT_CODE_PEPPER, domain-separated from event codes) is stored: a copy of the
 * table alone cannot be turned back into a working link, and only this server
 * can say which stored row a link belongs to. Single use, bound to one email,
 * seven days (src/lib/orgs/invites.ts).
 *
 * The token rides in the link's fragment (`#t=`), which browsers never send to a
 * server: it stays out of access logs, proxies, link scanners' requests and
 * Referer headers. The page at /invite/open hands it over in a POST.
 */
import { createHmac, randomBytes } from "node:crypto";
import { eventCodePepper } from "./codes";
import { safeEqual } from "../auth/safeEqual";
import { staffSecret } from "../auth/staffToken";
import { isUuid } from "./roles";

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

/* ---------------- "Join <org> as <role>?" after sign-in ---------------- */

/** How long a signed-in person has to answer the "Join … ?" question. */
export const INVITE_CONFIRM_TTL_MS = 15 * 60_000;

export interface InviteConfirm {
  /** The Supabase user the server itself just checked. */
  userId: string;
  /** Their confirmed email (normalised), which the invite was for. */
  email: string;
  /** The invite they were asked about. */
  inviteId: string;
}

const confirmMac = (body: string, secret: string) => createHmac("sha256", secret).update(`mb-invite-confirm:v1:${body}`).digest("base64url");

/**
 * Who may answer an invite in this browser: sealed right after a sign-in whose
 * confirmed email is the invited one, so the "Accept" that follows needs no
 * second sign-in and cannot be made for anybody else or another invite.
 */
export function sealInviteConfirm(c: InviteConfirm, now = Date.now(), secret = staffSecret()): string {
  const body = Buffer.from(JSON.stringify({ u: c.userId, e: c.email, i: c.inviteId, exp: now + INVITE_CONFIRM_TTL_MS })).toString("base64url");
  return `${body}.${confirmMac(body, secret)}`;
}

export function openInviteConfirm(sealed: string | null | undefined, now = Date.now(), secret = staffSecret()): InviteConfirm | null {
  if (typeof sealed !== "string" || sealed.length > 1000) return null;
  const dot = sealed.lastIndexOf(".");
  if (dot < 1) return null;
  const body = sealed.slice(0, dot);
  if (!safeEqual(sealed.slice(dot + 1), confirmMac(body, secret))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u?: unknown; e?: unknown; i?: unknown; exp?: unknown };
    if (typeof p.exp !== "number" || p.exp <= now || p.exp - now > INVITE_CONFIRM_TTL_MS + 60_000) return null;
    if (!isUuid(p.u) || !isUuid(p.i) || typeof p.e !== "string" || !p.e.includes("@")) return null;
    return { userId: p.u, email: p.e, inviteId: p.i };
  } catch {
    return null;
  }
}
