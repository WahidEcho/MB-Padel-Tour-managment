/**
 * XPay client: Move Score's own registration checkouts (docs/xpay-direct.md).
 *
 * Move Score takes registration payments directly through XPay (hosted checkout
 * sessions), on the same XPay account Move Tick uses for tickets, with its own
 * webhook endpoint (src/app/api/webhooks/xpay/route.ts) and signing secret. The
 * shape follows Move Tick's integration (Move-Tick src/lib/xpay/client.ts, branch
 * move-score-partner-api): Stripe-like sessions, amounts in minor units (piastres),
 * an Idempotency-Key on every create and refund.
 *
 * Environment:
 *   XPAY_SECRET_KEY            sk_test_… or sk_live_… (the mode is the key's prefix; any
 *                              other value counts as not configured: fail closed)
 *   XPAY_WEBHOOK_SECRET        the signing secret of Move Score's webhook endpoint in the
 *                              XPay dashboard (not Move Tick's: each endpoint has its own)
 *   XPAY_API_BASE              optional, default https://api.xpay.app (https; http only on
 *                              localhost, for the fake XPay of the tests and the demo)
 *   XPAY_PAYMENT_METHOD_TYPES  optional, comma-separated (e.g. "card,valu"): every type must
 *                              be enabled on the XPay account or XPay refuses the session
 *
 * Every checkout carries metadata { app: "move-score", registration_id, payment_id }:
 * events are matched only to Move Score's own payment rows, and Move Tick's ticket
 * sessions on the same account are ignored here (as Move Score's are there).
 *
 * Server-only (holds the secret key). No Node-only imports, so the pure parts can be tested.
 */

export type XpayMode = "test" | "live";

export interface XpayConfig {
  apiBase: string;
  secretKey: string;
  webhookSecret: string;
  mode: XpayMode;
  paymentMethodTypes: string[] | null;
}

/** XPay's card minimum: 50 EGP (Move Tick refuses paid tickets below it too). Minor units. */
export const XPAY_CARD_MINIMUM = 5000;
/**
 * How long XPay's own page stays payable: 30 minutes, XPay's minimum (its default is
 * 24 hours). Move Score's checkout hold is 15 minutes (CHECKOUT_HOLD_MS); after it the
 * page is closed through the expire endpoint (never while a card is completing on it),
 * and this is the backstop for a page nobody closed.
 */
export const XPAY_SESSION_EXPIRES_AFTER_MINUTES = 30;
export const XPAY_DEFAULT_API_BASE = "https://api.xpay.app";

/** `test` for an sk_test_ key, `live` for an sk_live_ key, null for anything else (not configured). */
export function keyMode(key: string | null | undefined): XpayMode | null {
  if (typeof key !== "string") return null;
  const k = key.trim();
  if (/^sk_test_[A-Za-z0-9_-]{8,}$/.test(k)) return "test";
  if (/^sk_live_[A-Za-z0-9_-]{8,}$/.test(k)) return "live";
  return null;
}

function localHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

const KNOWN_PAYMENT_METHOD_TYPES = new Set([
  "card",
  "fawry",
  "aman",
  "valu",
  "sympl",
  "tabby",
  "tamara",
  "vodafone_cash",
  "etisalat_cash",
  "orange_cash",
  "we_pay",
  "apple_pay",
  "google_pay",
  "samsung_pay",
  "instapay",
  "bank_transfer",
]);

/** XPAY_PAYMENT_METHOD_TYPES, known names only (an unknown one is dropped, so a typo cannot refuse every checkout). */
export function paymentMethodTypes(raw: string | null | undefined): string[] | null {
  if (!raw || !raw.trim()) return null;
  const wanted = raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const types = [...new Set(wanted.filter((t) => KNOWN_PAYMENT_METHOD_TYPES.has(t)))];
  return types.length ? types : null;
}

/** The configuration, or null when XPay is not configured on this server. */
export function xpayConfig(env: Record<string, string | undefined> = process.env): XpayConfig | null {
  const secretKey = (env.XPAY_SECRET_KEY ?? "").trim();
  const webhookSecret = (env.XPAY_WEBHOOK_SECRET ?? "").trim();
  const mode = keyMode(secretKey);
  if (!mode || webhookSecret.length < 16) return null;
  const apiBase = (env.XPAY_API_BASE ?? "").trim().replace(/\/+$/, "") || XPAY_DEFAULT_API_BASE;
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return null;
  }
  // http only for a local fake, and only with a test key: a live key never leaves over plain http.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost(url.hostname) && mode === "test")) return null;
  return { apiBase, secretKey, webhookSecret, mode, paymentMethodTypes: paymentMethodTypes(env.XPAY_PAYMENT_METHOD_TYPES) };
}

export class XpayError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

async function call(cfg: XpayConfig, method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; json: unknown; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${cfg.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.secretKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch {
    throw new XpayError("unreachable", "XPay could not be reached. Try again in a moment.");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** A checkout session as Move Score reads it (XPay's camelCase shape; only what is used). */
export interface XpaySession {
  id: string;
  /** open | complete | expired: whether the payer is done with the page. */
  status: string;
  /** paid | unpaid | no_payment_required: whether the money arrived (fulfil on this, never on status alone). */
  paymentStatus: string | null;
  /** Minor units, or null when XPay did not say. */
  amountTotal: number | null;
  currency: string | null;
  metadata: Record<string, string>;
  intentId: string | null;
  /** REQUIRES_PAYMENT_METHOD | REQUIRES_ACTION | PROCESSING | SUCCEEDED | FAILED | CANCELED | … (upper case) */
  intentStatus: string | null;
  url: string | null;
  expiresAt: string | null;
}

/** A session from XPay's JSON (create, retrieve, expire, or an event's data.object); null when it is not one. */
export function asSession(json: unknown): XpaySession | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;
  const id = str(j.id, 200);
  const status = str(j.status, 40);
  if (!id || !status) return null;
  const meta: Record<string, string> = {};
  if (j.metadata && typeof j.metadata === "object" && !Array.isArray(j.metadata)) {
    for (const [k, v] of Object.entries(j.metadata as Record<string, unknown>)) if (typeof v === "string" && k.length <= 40 && v.length <= 200) meta[k] = v;
  }
  const pi = j.paymentIntent && typeof j.paymentIntent === "object" ? (j.paymentIntent as Record<string, unknown>) : null;
  const amount = j.amountTotal;
  return {
    id,
    status: status.toLowerCase(),
    paymentStatus: str(j.paymentStatus, 40)?.toLowerCase() ?? null,
    amountTotal: Number.isInteger(amount) ? (amount as number) : null,
    currency: str(j.currency, 10)?.toUpperCase() ?? null,
    metadata: meta,
    intentId: str(pi?.id, 200) ?? str(j.paymentIntentId, 200),
    intentStatus: str(pi?.status, 60)?.trim().toUpperCase() ?? null,
    url: str(j.url, 2000),
    expiresAt: str(j.expiresAt, 40),
  };
}

/**
 * Where a session's money stands, for one question: may it be closed (and its place
 * given back) without a card still being able to complete on it? Mirrors Move Tick
 * (src/lib/xpay/session-state.ts on its partner branch):
 *   paid        the money arrived;
 *   releasable  no intent, or one that needs a payment method, failed or was cancelled;
 *   settling    anything else: a 3-D Secure challenge open, processing, or a completed
 *               page that is still unpaid (a Fawry-style reference to pay later).
 */
export function sessionMoney(s: Pick<XpaySession, "paymentStatus" | "status" | "intentId" | "intentStatus">): "paid" | "releasable" | "settling" {
  if (s.paymentStatus === "paid") return "paid";
  if (s.status === "complete") return "settling";
  if (!s.intentId && !s.intentStatus) return "releasable";
  if (s.intentStatus === "REQUIRES_PAYMENT_METHOD" || s.intentStatus === "FAILED" || s.intentStatus === "CANCELED" || s.intentStatus === "CANCELLED") return "releasable";
  // An intent with no readable status is unknown, which is not safe to release.
  return "settling";
}

/** The session id says its mode when it carries one (cs_test_… / cs_live_…); null when it does not. */
export function sessionIdMode(id: string): XpayMode | null {
  const m = /^cs_(test|live)_/.exec(id);
  return m ? (m[1] as XpayMode) : null;
}

function checkoutUrlOk(url: string, cfg: XpayConfig): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (cfg.mode === "test" && u.protocol === "http:" && localHost(u.hostname));
  } catch {
    return false;
  }
}

function refused(status: number, text: string): XpayError {
  let code = `http_${status}`;
  try {
    const j = JSON.parse(text) as { code?: unknown; error?: { code?: unknown } | unknown };
    const c = typeof j.code === "string" ? j.code : j.error && typeof j.error === "object" && typeof (j.error as { code?: unknown }).code === "string" ? (j.error as { code: string }).code : null;
    if (c) code = c.slice(0, 60);
  } catch {
    /* not JSON */
  }
  return new XpayError(code, "XPay refused the request.", status);
}

/**
 * A hosted checkout for one registration payment. The Idempotency-Key is derived
 * from the payment row's id: a retry (or a request racing this one) gets the same
 * session from XPay instead of a second payable page.
 */
export async function createCheckout(
  cfg: XpayConfig,
  input: { amount: number; description: string; returnUrl: string; registrationId: string; paymentId: string },
): Promise<XpaySession & { url: string }> {
  const body = (withExpiry: boolean) => ({
    afterCompletion: { type: "redirect", redirect: { url: input.returnUrl } },
    lineItems: [{ priceData: { currency: "EGP", unitAmount: input.amount, productData: { name: input.description.slice(0, 140) } }, quantity: 1 }],
    metadata: { app: "move-score", registration_id: input.registrationId, payment_id: input.paymentId },
    ...(withExpiry ? { expiresAfterMinutes: XPAY_SESSION_EXPIRES_AFTER_MINUTES } : {}),
    ...(cfg.paymentMethodTypes ? { paymentMethodTypes: cfg.paymentMethodTypes } : {}),
  });
  const key = `movescore-checkout-${input.paymentId}`;
  let res = await call(cfg, "POST", "/checkout/sessions", body(true), key);
  // An account or API version that does not take the expiry: a checkout without it is still
  // safe (Move Score closes the page at the end of its hold), a refused checkout is not.
  if (res.status === 400 && /expiresAfterMinutes|parameter_unknown/i.test(res.text)) {
    console.error("[xpay] session expiry parameter refused; creating without it");
    res = await call(cfg, "POST", "/checkout/sessions", body(false), key);
  }
  if (res.status < 200 || res.status >= 300) throw refused(res.status, res.text);
  const s = asSession(res.json);
  if (!s || !s.url || !checkoutUrlOk(s.url, cfg)) throw new XpayError("bad_response", "XPay answered something unexpected.", res.status);
  // XPay must answer for what was asked; anything else is not this payment.
  if ((s.amountTotal !== null && s.amountTotal !== input.amount) || (s.currency !== null && s.currency !== "EGP")) throw new XpayError("mismatch", "XPay answered for another amount.");
  if (s.metadata.payment_id && s.metadata.payment_id !== input.paymentId) throw new XpayError("mismatch", "XPay answered for another payment.");
  const idMode = sessionIdMode(s.id);
  if (idMode && idMode !== cfg.mode) throw new XpayError("mode", "XPay answered in the wrong mode for this server.");
  return { ...s, url: s.url };
}

/** GET /checkout/sessions/{id}: how a checkout stands (reconciliation, closing a lapsed one). */
export async function retrieveCheckout(cfg: XpayConfig, sessionId: string): Promise<XpaySession> {
  const res = await call(cfg, "GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (res.status < 200 || res.status >= 300) throw refused(res.status, res.text);
  const s = asSession(res.json);
  if (!s || s.id !== sessionId) throw new XpayError("bad_response", "XPay answered something unexpected.", res.status);
  return s;
}

/**
 * POST /checkout/sessions/{id}/expire: closes an open page so it can no longer be
 * paid. XPay refuses to expire a session that is not open, so the answer is read
 * back with GET either way: callers act on the session's real status.
 */
export async function expireCheckout(cfg: XpayConfig, sessionId: string): Promise<XpaySession> {
  const res = await call(cfg, "POST", `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`);
  if (res.status >= 200 && res.status < 300) {
    const s = asSession(res.json);
    if (s && s.id === sessionId) return s;
  }
  return retrieveCheckout(cfg, sessionId);
}

/**
 * POST /refunds { paymentIntentId }: a full refund of the payment (XPay refunds the
 * whole intent when no amount is named; Move Score only refunds in full). XPay has no
 * per-intent refund dedupe of its own, so the Idempotency-Key (the payment row's id)
 * is what keeps a retried or double-clicked refund from refunding twice.
 */
export async function refundIntent(cfg: XpayConfig, input: { intentId: string; paymentId: string }): Promise<{ refundId: string | null; status: string | null }> {
  const res = await call(cfg, "POST", "/refunds", { paymentIntentId: input.intentId }, `movescore-refund-full-${input.paymentId}`);
  if (res.status < 200 || res.status >= 300) throw refused(res.status, res.text);
  const j = (res.json ?? {}) as Record<string, unknown>;
  const status = str(j.status, 40)?.toLowerCase() ?? null;
  if (status === "failed" || status === "canceled" || status === "cancelled") throw new XpayError("refund_failed", "XPay did not take the refund.", res.status);
  return { refundId: str(j.id, 120), status };
}
