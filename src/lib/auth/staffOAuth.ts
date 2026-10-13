/**
 * The web staff Google sign-in's state cookie: the PKCE verifier and where to go
 * afterwards, HMAC-signed so the callback can trust what it reads back, valid ten
 * minutes. Server-only (node:crypto).
 */
import { createHmac } from "node:crypto";
import { safeEqual } from "./safeEqual";
import { staffSecret } from "./staffToken";
import { safeNextPath } from "./staffRedirect";
import { isCodeVerifier } from "../mobile/oauth";

export const STAFF_OAUTH_COOKIE = "mb_staff_oauth";

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(`oauth:${body}`).digest("base64url");

export function sealOAuthState(verifier: string, next: string | null, now = Date.now(), secret = staffSecret()): string {
  const body = Buffer.from(JSON.stringify({ v: verifier, n: next, exp: now + 10 * 60_000 })).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

export function openOAuthState(sealed: string | undefined, now = Date.now(), secret = staffSecret()): { verifier: string; next: string | null } | null {
  if (!sealed || sealed.length > 1000) return null;
  const dot = sealed.lastIndexOf(".");
  if (dot < 1) return null;
  const body = sealed.slice(0, dot);
  const sig = sealed.slice(dot + 1);
  const expected = mac(body, secret);
  if (!safeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { v?: unknown; n?: unknown; exp?: unknown };
    if (typeof p.exp !== "number" || p.exp <= now || !isCodeVerifier(p.v)) return null;
    return { verifier: p.v, next: safeNextPath(p.n) };
  } catch {
    return null;
  }
}
