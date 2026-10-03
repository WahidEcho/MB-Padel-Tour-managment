/**
 * Email through Resend's REST API (no SDK), and its webhooks.
 *
 * Sending: POST /emails/batch takes up to 100 messages in one request, which is
 * what keeps a large announcement inside Resend's per-second request limit. A
 * batch is all-or-nothing on validation, so when Resend rejects one, the chunk is
 * sent again one by one to find out which address was the problem.
 *
 * Webhooks are signed the Svix way: HMAC-SHA256 over "id.timestamp.body" with the
 * base64 key after "whsec_", sent as "v1,<base64>" (several, space separated).
 *
 * The pure parts (validation, signature check, webhook mapping, error wording)
 * are tested; `resendRequest` is the only network call.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { DeliveryStatus } from "./status";

export const RESEND_API = "https://api.resend.com";
export const BATCH_LIMIT = 100;

export interface EmailMessage {
  /** message_deliveries.id — also sent as a tag so webhooks can find the row. */
  deliveryId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendOutcome =
  | { ok: true; providerId: string }
  | { ok: false; code: string; reason: string; transient: boolean };

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

export function isValidEmail(raw: string | null | undefined): boolean {
  return !!raw && raw.length <= 254 && EMAIL_RE.test(raw.trim());
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  return isValidEmail(e) ? e : null;
}

/** Sender defaults: the Move Score no-reply address on the Resend-verified mbeg.org domain. */
export const DEFAULT_FROM_EMAIL = "no-reply@mbeg.org";
export const DEFAULT_FROM_NAME = "Move Score";
export const DEFAULT_REPLY_TO = "info@mbeg.org";

/** "Move Score <no-reply@mbeg.org>", or RESEND_FROM_NAME / RESEND_FROM_EMAIL when set. */
export function fromHeader(env: NodeJS.ProcessEnv = process.env): string {
  const email = (env.RESEND_FROM_EMAIL || DEFAULT_FROM_EMAIL).trim();
  const name = (env.RESEND_FROM_NAME || DEFAULT_FROM_NAME).replace(/[<>"]/g, "").trim();
  return `${name} <${email}>`;
}

/** Where replies go: RESEND_REPLY_TO, default info@mbeg.org. */
export function replyTo(env: NodeJS.ProcessEnv = process.env): string {
  return (env.RESEND_REPLY_TO || DEFAULT_REPLY_TO).trim();
}

export function resendBody(m: EmailMessage, from: string, reply: string | null = DEFAULT_REPLY_TO) {
  return {
    from,
    to: [m.to],
    ...(reply ? { reply_to: reply } : {}),
    subject: m.subject,
    html: m.html,
    text: m.text,
    tags: [{ name: "delivery", value: m.deliveryId }],
  };
}

/** Turns a Resend error response into something an organiser can act on. */
export function describeResendError(status: number, body: { name?: string; message?: string } | null): { code: string; reason: string; transient: boolean } {
  const name = body?.name ?? `http_${status}`;
  const message = body?.message ?? "";
  if (status === 429) return { code: name || "rate_limit_exceeded", reason: "Resend rate limit — will retry", transient: true };
  if (status >= 500) return { code: name, reason: `Resend is having trouble (${status}) — will retry`, transient: true };
  if (status === 401 || name === "missing_api_key" || name === "restricted_api_key")
    return { code: name, reason: "Resend API key is missing or not allowed to send", transient: false };
  if (status === 403)
    return { code: name, reason: `Sender not allowed — verify the RESEND_FROM_EMAIL domain in Resend. ${message}`.trim(), transient: false };
  if (status === 422 || status === 400) return { code: name || "validation_error", reason: message || "Resend rejected the message", transient: false };
  return { code: name, reason: message || `Resend error ${status}`, transient: status === 408 };
}

/* ---------------- webhooks ---------------- */

/**
 * Checks a Svix-signed webhook. `secret` is the endpoint's signing secret
 * ("whsec_…"). Rejects timestamps more than five minutes off, like Svix's own
 * libraries, so a captured request cannot be replayed later.
 */
export function verifySvixSignature(
  secret: string | undefined,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  nowMs = Date.now(),
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();
  for (const part of headers.signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const got = Buffer.from(sig, "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

/** Signs like Svix — for tests and the end-to-end script. */
export function signSvix(secret: string, id: string, timestamp: string, rawBody: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64")}`;
}

export interface ResendEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    tags?: Tags;
    bounce?: { message?: string; type?: string; subType?: string };
    failed?: { reason?: string };
  };
}

export interface StatusUpdate {
  providerId: string | null;
  deliveryId: string | null;
  status: DeliveryStatus;
  errorCode?: string | null;
  errorReason?: string | null;
  at: string;
}

type Tags = Record<string, string> | { name: string; value: string }[] | undefined;

function tagValue(tags: Tags, name: string): string | null {
  if (!tags) return null;
  if (Array.isArray(tags)) return tags.find((t) => t.name === name)?.value ?? null;
  return tags[name] ?? null;
}

/** What a Resend webhook means for the delivery row, or null when nothing changes. */
export function mapResendEvent(ev: ResendEvent): StatusUpdate | null {
  const providerId = ev.data?.email_id ?? null;
  const deliveryId = tagValue(ev.data?.tags, "delivery");
  const at = ev.created_at ?? new Date().toISOString();
  const base = { providerId, deliveryId, at };
  switch (ev.type) {
    case "email.sent":
      return { ...base, status: "sent" };
    case "email.delivered":
      return { ...base, status: "delivered" };
    case "email.opened":
    case "email.clicked":
      return { ...base, status: "read" };
    case "email.bounced": {
      const b = ev.data?.bounce;
      const kind = [b?.type, b?.subType].filter(Boolean).join(" / ");
      return {
        ...base,
        status: "bounced",
        errorCode: b?.subType ?? b?.type ?? "bounced",
        errorReason: `Email bounced${kind ? ` (${kind})` : ""}${b?.message ? `: ${b.message}` : ""}`.slice(0, 500),
      };
    }
    case "email.complained":
      return { ...base, status: "complained", errorCode: "complained", errorReason: "The recipient marked it as spam" };
    case "email.failed":
      return { ...base, status: "failed", errorCode: "failed", errorReason: (ev.data?.failed?.reason ?? "Resend could not send it").slice(0, 500) };
    default:
      // email.delivery_delayed, email.scheduled, contact.* …: nothing to record.
      return null;
  }
}

/* ---------------- network ---------------- */

export async function resendRequest(
  path: string,
  body: unknown,
  opts: { apiKey: string; idempotencyKey?: string; timeoutMs?: number },
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(`${RESEND_API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}
