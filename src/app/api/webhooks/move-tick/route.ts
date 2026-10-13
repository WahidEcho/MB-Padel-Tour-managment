import { NextResponse } from "next/server";
import { moveTickConfig, parseWebhook } from "@/lib/registration/moveTick";
import { SIGNATURE_HEADER, verifySignature } from "@/lib/registration/signature";
import { applyWebhook } from "@/lib/registration/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 16_000;
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Move Tick → Move Score payment events (docs/move-tick-partner-api.md).
 *
 * Signed: `MoveTick-Signature: t=<unix>,v1=<HMAC-SHA256(MOVE_TICK_WEBHOOK_SECRET, "<t>.<raw body>")>`,
 * five-minute replay window, constant-time compare (src/lib/registration/signature.ts).
 * Idempotent: an event id is applied once; every status change is conditional on
 * the status it moves from, keyed by the registration reference.
 *
 * Answers: 200 when applied, already applied, or about nothing of ours (Move Tick
 * stops retrying); 400/401 for a malformed or unsigned request (not retried); 503
 * when Move Tick is not configured here; 500 on an error (Move Tick retries).
 * Nothing in the answer says whether a reference exists.
 */
export async function POST(request: Request) {
  const cfg = moveTickConfig();
  if (!cfg) return json({ error: "Not configured" }, 503);
  const raw = await request.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY) return json({ error: "Bad request" }, 400);
  const sig = verifySignature(request.headers.get(SIGNATURE_HEADER), raw, cfg.webhookSecret);
  if (!sig.ok) return json({ error: "Invalid signature", reason: sig.reason === "stale" ? "stale" : "invalid" }, 401);
  const event = parseWebhook(raw);
  if (!event) return json({ error: "Bad request" }, 400);
  try {
    const outcome = await applyWebhook(event);
    // Duplicates and unknown references answer like a success: nothing to retry, nothing learned.
    return json({ received: true, duplicate: outcome === "duplicate" }, 200);
  } catch (err) {
    console.error("[move-tick webhook] failed", err instanceof Error ? err.message : err);
    return json({ error: "Try again" }, 500);
  }
}

export function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
}
