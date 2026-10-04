import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { parseWaWebhook, verifyMetaSignature, type WaWebhook } from "@/lib/messaging/whatsapp";
import { applyStatusUpdates, recordInbound } from "@/lib/messaging/queue";

/**
 * WhatsApp Cloud API webhook (https://tour.mbeg.org/api/webhooks/whatsapp).
 *
 * GET is Meta's one-time handshake: echo hub.challenge when hub.verify_token is
 * WA_CLOUD_VERIFY_TOKEN. POST carries message statuses (sent, delivered, read,
 * failed with an error code — 131026 is "not on WhatsApp") and inbound messages;
 * it is signed with the app secret (X-Hub-Signature-256) and refused otherwise.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const want = process.env.WA_CLOUD_VERIFY_TOKEN ?? "";
  const got = params.get("hub.verify_token") ?? "";
  const match = want.length > 0 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (params.get("hub.mode") === "subscribe" && match) {
    return new Response(params.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyMetaSignature(process.env.WA_CLOUD_APP_SECRET, raw, request.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let body: WaWebhook;
  try {
    body = JSON.parse(raw) as WaWebhook;
  } catch {
    return NextResponse.json({ ok: true });
  }
  const { updates, inbound } = parseWaWebhook(body);
  try {
    const first = await applyStatusUpdates(updates);
    let changed = first.changed;
    // Meta can report "sent" before our own write of the message id lands: one short second look.
    const early = first.missing.filter((u) => u.status === "sent" || u.status === "failed");
    if (early.length && early.length <= 20) {
      await new Promise((r) => setTimeout(r, 1500));
      changed += (await applyStatusUpdates(early)).changed;
    }
    await recordInbound(inbound);
    return NextResponse.json({ ok: true, changed });
  } catch (err) {
    // Meta retries non-200 responses for days; a database hiccup is worth that.
    console.error("[whatsapp:webhook]", err);
    return NextResponse.json({ error: "Could not record" }, { status: 500 });
  }
}
