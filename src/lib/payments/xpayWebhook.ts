/**
 * XPay webhook signatures and events (docs/xpay-direct.md).
 *
 *   XPay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(endpoint signing secret, "<t>.<raw body>")>
 *
 * The scheme Move Tick verifies for its own endpoint (Move-Tick src/lib/xpay/webhook.ts,
 * checked against docs.xpay.app): the raw body before any parsing, a five-minute
 * replay window, a constant-time compare. Several v1 values may be present (secret
 * rotation): one matching is enough.
 *
 * Server-only (node:crypto).
 */
import { createHmac } from "node:crypto";
import { safeEqual } from "../auth/safeEqual";
import { asSession, type XpaySession } from "./xpay";

export const XPAY_SIGNATURE_HEADER = "xpay-signature";
export const XPAY_REPLAY_WINDOW_SECONDS = 300;

export function xpaySignatureFor(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** The header value XPay sends (and the tests' fake XPay signs with). */
export function xpaySignatureHeader(secret: string, rawBody: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${xpaySignatureFor(secret, t, rawBody)}`;
}

export type XpaySignatureRefusal = "missing" | "malformed" | "stale" | "mismatch" | "no_secret";

export function verifyXpaySignature(
  header: string | null | undefined,
  rawBody: string,
  secret: string | null | undefined,
  now = Date.now(),
  windowSeconds = XPAY_REPLAY_WINDOW_SECONDS,
): { ok: true; timestamp: number } | { ok: false; reason: XpaySignatureRefusal } {
  if (!secret || secret.length < 16) return { ok: false, reason: "no_secret" };
  if (!header) return { ok: false, reason: "missing" };
  if (header.length > 2000) return { ok: false, reason: "malformed" };
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) return { ok: false, reason: "malformed" };
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") {
      if (!/^\d{1,12}$/.test(v)) return { ok: false, reason: "malformed" };
      t = Number(v);
    } else if (k === "v1") {
      if (!/^[0-9a-f]{64}$/i.test(v)) return { ok: false, reason: "malformed" };
      sigs.push(v.toLowerCase());
    }
    // Other schemes (v0, …) are ignored, as Stripe-style verifiers do.
  }
  if (t === null || sigs.length === 0) return { ok: false, reason: "malformed" };
  if (Math.abs(Math.floor(now / 1000) - t) > windowSeconds) return { ok: false, reason: "stale" };
  const want = xpaySignatureFor(secret, t, rawBody);
  // Every candidate is compared (no early exit on the first match), in constant time.
  let match = false;
  for (const s of sigs) match = safeEqual(s, want) || match;
  return match ? { ok: true, timestamp: t } : { ok: false, reason: "mismatch" };
}

/** The checkout events Move Score acts on; any other type is acknowledged and ignored. */
export const XPAY_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
] as const;
export type XpayEventType = (typeof XPAY_EVENT_TYPES)[number];

export interface XpayEvent {
  id: string;
  type: string;
  /** XPay's livemode flag when the event carries one (Stripe-style); null when it does not. */
  livemode: boolean | null;
  /** The checkout session (data.object) for a checkout event; null for any other event. */
  session: XpaySession | null;
}

/** The event, when the (already signature-checked) body is one; null for a body that is not an event at all. */
export function parseXpayEvent(raw: string): XpayEvent | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const e = j as Record<string, unknown>;
  const id = typeof e.id === "string" && e.id.length > 0 && e.id.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(e.id) ? e.id : null;
  const type = typeof e.type === "string" && e.type.length <= 100 ? e.type : null;
  if (!id || !type) return null;
  const data = e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : null;
  const isCheckout = (XPAY_EVENT_TYPES as readonly string[]).includes(type);
  return {
    id,
    type,
    livemode: typeof e.livemode === "boolean" ? e.livemode : null,
    session: isCheckout ? asSession(data?.object) : null,
  };
}

/**
 * What a checkout event means for a Move Score payment, in the terms the payment
 * rows use. Fulfils on paymentStatus === "paid" only, never on the type or on
 * status alone: a Fawry-style reference completes the page unpaid (wait), and the
 * money arrives later as async_payment_succeeded (or never: async_payment_failed).
 */
export function eventOutcome(type: string, s: Pick<XpaySession, "paymentStatus">): "payment.succeeded" | "payment.failed" | "payment.expired" | "awaiting" | null {
  if (!(XPAY_EVENT_TYPES as readonly string[]).includes(type)) return null;
  // A paid session is never dropped, whatever the event says.
  if (s.paymentStatus === "paid") return "payment.succeeded";
  if (type === "checkout.session.async_payment_failed") return "payment.failed";
  if (type === "checkout.session.expired") return "payment.expired";
  // completed but unpaid: the payer holds a reference to pay later; nothing to do until it is paid or fails.
  return "awaiting";
}
