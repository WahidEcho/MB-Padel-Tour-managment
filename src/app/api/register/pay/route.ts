import { NextResponse } from "next/server";
import { clientIpFrom, takeRateLimit } from "@/lib/ratelimit";
import { sameOrigin } from "@/lib/orgs/invites";
import { payFromStatus, returnUrlFor } from "@/lib/registration/server";
import { HELD_FULL_MESSAGE } from "@/lib/registration/rules";
import { siteUrl } from "@/lib/messaging/links";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Pay button on the signed status page (the way a web guest pays once the
 * organiser approved): a form POST of { r, s } → 303 to the online checkout
 * (the open one when there is one: never a second), or back to the status page
 * with the reason. Anyone holding the signed status link may pay; paying is all it
 * can do. Rate-limited per network address.
 */
export async function POST(request: Request) {
  if (request.headers.get("origin") && !sameOrigin(request)) return NextResponse.json({ error: "Open your registration's page to pay." }, { status: 403 });
  const limit = await takeRateLimit({ key: `reg-pay-ip:${clientIpFrom(request.headers)}`, limit: 20, windowSeconds: 600 });
  if (!limit.allowed) return NextResponse.json({ error: "Too many attempts. Please try again shortly." }, { status: 429 });
  const form = await request.formData().catch(() => null);
  const r = String(form?.get("r") ?? "").slice(0, 40);
  const s = String(form?.get("s") ?? "").slice(0, 64);
  if (!UUID.test(r)) return NextResponse.redirect(`${siteUrl()}/register/status`, 303);
  const out = await payFromStatus(r, s);
  if (!out.ok) {
    if (out.status === 404) return NextResponse.redirect(`${siteUrl()}/register/status`, 303);
    // Full only while other players' checkouts are open: the page says a place may free up (never the server's words in the URL).
    const code = out.code === "full" && out.error === HELD_FULL_MESSAGE ? "full_held" : out.code;
    return NextResponse.redirect(`${returnUrlFor(r)}&e=${encodeURIComponent(code)}`, 303);
  }
  return NextResponse.redirect(out.value.checkoutUrl, 303);
}
