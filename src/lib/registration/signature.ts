/**
 * Move Tick webhook signatures (docs/move-tick-partner-api.md).
 *
 *   MoveTick-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The same scheme Move Tick's own payment provider (XPay) uses, so both sides
 * share one implementation shape. Verification: the timestamp must be within five
 * minutes of now (replay window), the HMAC is compared in constant time, and any
 * malformed header is refused. Several v1 values may be present (secret rotation):
 * one matching is enough.
 *
 * Server-only (node:crypto).
 */
import { createHmac } from "node:crypto";
import { safeEqual } from "../auth/safeEqual";

export const SIGNATURE_HEADER = "movetick-signature";
export const REPLAY_WINDOW_SECONDS = 300;

export function signatureFor(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** The header value Move Tick sends (and the E2E's fake Move Tick signs with). */
export function signatureHeader(secret: string, rawBody: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${signatureFor(secret, t, rawBody)}`;
}

export type SignatureRefusal = "missing" | "malformed" | "stale" | "mismatch" | "no_secret";

export function verifySignature(
  header: string | null | undefined,
  rawBody: string,
  secret: string | null | undefined,
  now = Date.now(),
  windowSeconds = REPLAY_WINDOW_SECONDS,
): { ok: true; timestamp: number } | { ok: false; reason: SignatureRefusal } {
  if (!secret || secret.length < 32) return { ok: false, reason: "no_secret" };
  if (!header) return { ok: false, reason: "missing" };
  if (header.length > 1000) return { ok: false, reason: "malformed" };
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2) as [string, string | undefined];
    if (!v) return { ok: false, reason: "malformed" };
    if (k === "t") {
      if (!/^\d{1,12}$/.test(v)) return { ok: false, reason: "malformed" };
      t = Number(v);
    } else if (k === "v1") {
      if (!/^[0-9a-f]{64}$/.test(v)) return { ok: false, reason: "malformed" };
      sigs.push(v);
    }
  }
  if (t === null || sigs.length === 0) return { ok: false, reason: "malformed" };
  if (Math.abs(Math.floor(now / 1000) - t) > windowSeconds) return { ok: false, reason: "stale" };
  const want = signatureFor(secret, t, rawBody);
  // Every candidate is compared (no early exit on the first match), in constant time.
  let match = false;
  for (const s of sigs) match = safeEqual(s, want) || match;
  return match ? { ok: true, timestamp: t } : { ok: false, reason: "mismatch" };
}
