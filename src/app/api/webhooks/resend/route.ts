import { NextResponse } from "next/server";
import { mapResendEvent, verifySvixSignature, type ResendEvent } from "@/lib/messaging/email";
import { applyStatusUpdates } from "@/lib/messaging/queue";

/**
 * Resend delivery reports (register https://tour.mbeg.org/api/webhooks/resend
 * in Resend → Webhooks; its signing secret is RESEND_WEBHOOK_SECRET). Signed the
 * Svix way; unsigned or stale requests are refused. Emails this platform did not
 * send (the Resend account is shared with Move-Tick) are acknowledged and ignored.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const ok = verifySvixSignature(
    process.env.RESEND_WEBHOOK_SECRET,
    { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") },
    raw,
  );
  if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  let event: ResendEvent;
  try {
    event = JSON.parse(raw) as ResendEvent;
  } catch {
    return NextResponse.json({ ok: true });
  }
  const update = mapResendEvent(event);
  if (!update) return NextResponse.json({ ok: true, ignored: event.type });
  try {
    const { changed } = await applyStatusUpdates([update]);
    return NextResponse.json({ ok: true, changed });
  } catch (err) {
    // A database hiccup: let Resend retry later.
    console.error("[resend:webhook]", err);
    return NextResponse.json({ error: "Could not record" }, { status: 500 });
  }
}
