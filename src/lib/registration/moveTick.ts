/**
 * Move Tick partner API client (docs/move-tick-partner-api.md).
 *
 * Move Score asks Move Tick for a hosted checkout for one registration (the
 * amount and currency always come from Move Score's own registration row, never
 * from a client), and asks it to refund. Move Tick tells Move Score what happened
 * through signed webhooks (src/app/api/webhooks/move-tick/route.ts).
 *
 * Environment (all three, or online payment is unavailable and every fee is paid
 * at the venue):
 *   MOVE_TICK_API_URL         e.g. https://move-tick.mbeg.org (https; http only on localhost)
 *   MOVE_TICK_PARTNER_KEY     the bearer key Move Tick issued to Move Score (32+ characters)
 *   MOVE_TICK_WEBHOOK_SECRET  signs Move Tick's webhooks to Move Score (32+ characters)
 *   MOVE_TICK_MODE            "live" or "test" (default: live in production, test elsewhere).
 *                             A webhook whose testMode disagrees is refused, so a test-card
 *                             payment can never confirm a real entry.
 *
 * Server-only.
 */

export type MoveTickMode = "live" | "test";

export interface MoveTickConfig {
  apiUrl: string;
  partnerKey: string;
  webhookSecret: string;
  mode: MoveTickMode;
}

function localHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

/** The configuration, or null when online payment is not available. */
export function moveTickConfig(env: Record<string, string | undefined> = process.env): MoveTickConfig | null {
  const apiUrl = (env.MOVE_TICK_API_URL ?? "").trim().replace(/\/+$/, "");
  const partnerKey = (env.MOVE_TICK_PARTNER_KEY ?? "").trim();
  const webhookSecret = (env.MOVE_TICK_WEBHOOK_SECRET ?? "").trim();
  if (!apiUrl || partnerKey.length < 32 || webhookSecret.length < 32) return null;
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost(url.hostname))) return null;
  const raw = (env.MOVE_TICK_MODE ?? "").trim();
  const mode: MoveTickMode = raw === "live" || raw === "test" ? raw : env.NODE_ENV === "production" ? "live" : "test";
  return { apiUrl, partnerKey, webhookSecret, mode };
}

export class MoveTickError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

async function call<T>(cfg: MoveTickConfig, method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${cfg.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.partnerKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch {
    throw new MoveTickError("unreachable", "Move Tick could not be reached. Try again in a moment.");
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
  if (!res.ok) {
    const j = (json ?? {}) as { code?: unknown; error?: unknown };
    const code = typeof j.code === "string" ? j.code.slice(0, 60) : `http_${res.status}`;
    throw new MoveTickError(code, "Move Tick refused the request.", res.status);
  }
  if (!json || typeof json !== "object") throw new MoveTickError("bad_response", "Move Tick answered something unexpected.", res.status);
  return json as T;
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

export interface PaymentSession {
  sessionId: string;
  checkoutUrl: string;
  status: "open" | "paid" | "failed" | "expired" | "refunded" | "refund_pending" | "needs_review";
  amount: number;
  currency: string;
  reference: string;
  expiresAt: string | null;
  testMode: boolean;
}

const SESSION_STATUSES = ["open", "paid", "failed", "expired", "refunded", "refund_pending", "needs_review"] as const;

function checkoutUrlOk(url: string, cfg: MoveTickConfig): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (cfg.mode === "test" && u.protocol === "http:" && localHost(u.hostname));
  } catch {
    return false;
  }
}

function asSession(json: unknown, cfg: MoveTickConfig): PaymentSession {
  const j = (json ?? {}) as Record<string, unknown>;
  const sessionId = str(j.sessionId, 120);
  const checkoutUrl = str(j.checkoutUrl, 2000);
  const reference = str(j.reference, 64);
  const status = SESSION_STATUSES.find((s) => s === j.status);
  if (!sessionId || !checkoutUrl || !reference || !status || !Number.isInteger(j.amount) || j.currency !== "EGP" || !checkoutUrlOk(checkoutUrl, cfg)) {
    throw new MoveTickError("bad_response", "Move Tick answered something unexpected.");
  }
  return {
    sessionId,
    checkoutUrl,
    status,
    amount: j.amount as number,
    currency: "EGP",
    reference,
    expiresAt: str(j.expiresAt, 40),
    testMode: j.testMode === true,
  };
}

/**
 * A hosted checkout for one registration payment. `idempotencyKey` is the payment
 * row's id: a retry returns the same session instead of a second one.
 */
export async function createPaymentSession(
  cfg: MoveTickConfig,
  input: {
    reference: string;
    amount: number;
    currency: "EGP";
    description: string;
    returnUrl: string;
    customer: { name: string; email: string | null; phone: string | null };
    idempotencyKey: string;
  },
): Promise<PaymentSession> {
  const json = await call<unknown>(
    cfg,
    "POST",
    "/api/partner/v1/payment-sessions",
    {
      reference: input.reference,
      amount: input.amount,
      currency: input.currency,
      description: input.description.slice(0, 140),
      returnUrl: input.returnUrl,
      customer: input.customer,
    },
    input.idempotencyKey,
  );
  const s = asSession(json, cfg);
  // Move Tick must echo what was asked; anything else is not this payment.
  if (s.reference !== input.reference || s.amount !== input.amount) throw new MoveTickError("mismatch", "Move Tick answered for another payment.");
  if (s.testMode !== (cfg.mode === "test")) throw new MoveTickError("mode", "Move Tick is in the wrong mode for this server.");
  return s;
}

export async function getPaymentSession(cfg: MoveTickConfig, sessionId: string): Promise<PaymentSession> {
  return asSession(await call<unknown>(cfg, "GET", `/api/partner/v1/payment-sessions/${encodeURIComponent(sessionId)}`), cfg);
}

/** Asks Move Tick to refund (all, or `amount` when a card fee is kept). The result arrives as a webhook too. */
export async function refundPaymentSession(
  cfg: MoveTickConfig,
  input: { sessionId: string; reference: string; amount: number; reason: string; idempotencyKey: string },
): Promise<{ refundId: string | null; status: "refunded" | "refund_pending" }> {
  const json = await call<Record<string, unknown>>(
    cfg,
    "POST",
    `/api/partner/v1/payment-sessions/${encodeURIComponent(input.sessionId)}/refund`,
    { reference: input.reference, amount: input.amount, reason: input.reason.slice(0, 200) },
    input.idempotencyKey,
  );
  const status = json.status === "refunded" ? "refunded" : json.status === "refund_pending" ? "refund_pending" : null;
  if (!status) throw new MoveTickError("bad_response", "Move Tick answered something unexpected.");
  return { refundId: str(json.refundId, 120), status };
}

/* ---------------- webhooks ---------------- */

export type WebhookType = "payment.succeeded" | "payment.failed" | "payment.expired" | "payment.refunded";
export const WEBHOOK_TYPES: readonly WebhookType[] = ["payment.succeeded", "payment.failed", "payment.expired", "payment.refunded"];

export interface WebhookEvent {
  id: string;
  type: WebhookType;
  createdAt: string;
  data: {
    sessionId: string;
    reference: string;
    amount: number;
    currency: string;
    refundedAmount: number | null;
    testMode: boolean;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The event, when the (already signature-checked) body has exactly the contract's shape; null otherwise. */
export function parseWebhook(raw: string): WebhookEvent | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const e = j as Record<string, unknown>;
  const d = (e.data ?? null) as Record<string, unknown> | null;
  const id = str(e.id, 120);
  const type = WEBHOOK_TYPES.find((t) => t === e.type);
  if (!id || !type || !d || typeof d !== "object") return null;
  const sessionId = str(d.sessionId, 120);
  const reference = str(d.reference, 64);
  if (!sessionId || !reference || !UUID.test(reference) || !Number.isInteger(d.amount) || (d.amount as number) < 0 || typeof d.currency !== "string") return null;
  const refunded = d.refundedAmount === undefined || d.refundedAmount === null ? null : Number.isInteger(d.refundedAmount) ? (d.refundedAmount as number) : NaN;
  if (Number.isNaN(refunded)) return null;
  return {
    id,
    type,
    createdAt: str(e.createdAt, 40) ?? new Date().toISOString(),
    data: { sessionId, reference: reference.toLowerCase(), amount: d.amount as number, currency: d.currency, refundedAmount: refunded, testMode: d.testMode === true },
  };
}
