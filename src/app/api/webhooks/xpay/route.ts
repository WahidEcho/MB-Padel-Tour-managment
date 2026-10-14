import { NextResponse } from "next/server";
import { xpayConfig } from "@/lib/payments/xpay";
import { XPAY_SIGNATURE_HEADER, parseXpayEvent, verifyXpaySignature } from "@/lib/payments/xpayWebhook";
import { applyXpayEvent } from "@/lib/registration/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 64_000;
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * XPay → Move Score payment events (docs/xpay-direct.md): Move Score's own webhook
 * endpoint in the XPay dashboard, with its own signing secret (XPAY_WEBHOOK_SECRET).
 *
 * Signed: `XPay-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<raw body>")>`, five-minute
 * replay window, constant-time compare (src/lib/payments/xpayWebhook.ts). Idempotent: an
 * event id is applied once; every status change is conditional on the status it moves from.
 *
 * XPay sends every event of the account to every endpoint, so Move Tick's ticket checkouts
 * arrive here too: a session that is not one of Move Score's own payments (its metadata names
 * another app, or no payment row has it) is acknowledged and ignored, never an error.
 *
 * Answers: 200 when applied, already applied, waiting (a reference to pay later) or about
 * nothing of ours (XPay stops retrying); 400 for a bad signature or a body that is not an
 * event (not retried); 503 when XPay is not configured here; 500 on a database or transient
 * error (XPay retries; a retry is safe). Nothing in the answer says whether a payment exists.
 */
export async function POST(request: Request) {
  const cfg = xpayConfig();
  if (!cfg) return json({ error: "Not configured" }, 503);
  const raw = await request.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY) return json({ error: "Bad request" }, 400);
  const sig = verifyXpaySignature(request.headers.get(XPAY_SIGNATURE_HEADER), raw, cfg.webhookSecret);
  if (!sig.ok) return json({ error: "Invalid signature", reason: sig.reason === "stale" ? "stale" : "invalid" }, 400);
  const event = parseXpayEvent(raw);
  if (!event) return json({ error: "Bad request" }, 400);
  try {
    const outcome = await applyXpayEvent(event);
    // Duplicates, other apps' sessions and unknown ones answer like a success: nothing to retry, nothing learned.
    return json({ received: true, duplicate: outcome === "duplicate" }, 200);
  } catch (err) {
    console.error("[xpay webhook] failed", event.type, err instanceof Error ? err.message : err);
    return json({ error: "Try again" }, 500);
  }
}

export function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
}
