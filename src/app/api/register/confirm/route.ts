import { NextResponse } from "next/server";
import { clientIpFrom, takeRateLimit } from "@/lib/ratelimit";
import { sameOrigin } from "@/lib/orgs/invites";
import { confirmGuest, returnUrlFor } from "@/lib/registration/server";
import { siteUrl } from "@/lib/messaging/links";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const back = (r: string, c: string, e: string) => `${siteUrl()}/register/confirm?r=${encodeURIComponent(r)}&c=${encodeURIComponent(c)}&e=${encodeURIComponent(e)}`;

/**
 * The button on /register/confirm (the page the emailed link opens): a form POST
 * of { r, c }. Only a POST confirms, so a mail scanner that fetches the link
 * confirms nothing. A wrong token is "not found", like a missing registration.
 * Rate-limited per network address. Answers with a 303 to the signed status page,
 * or back to the confirm page with the reason.
 */
export async function POST(request: Request) {
  if (request.headers.get("origin") && !sameOrigin(request)) return NextResponse.json({ error: "Open the link from your email to confirm." }, { status: 403 });
  const limit = await takeRateLimit({ key: `reg-confirm-ip:${clientIpFrom(request.headers)}`, limit: 20, windowSeconds: 600 });
  if (!limit.allowed) return NextResponse.json({ error: "Too many attempts. Please try again shortly." }, { status: 429 });
  const form = await request.formData().catch(() => null);
  const r = String(form?.get("r") ?? "").slice(0, 40);
  const c = String(form?.get("c") ?? "").slice(0, 64);
  if (!UUID.test(r) || !c) return NextResponse.redirect(back(r, c, "not_found"), 303);
  const out = await confirmGuest(r, c);
  if (!out.ok) return NextResponse.redirect(back(r, c, out.code), 303);
  return NextResponse.redirect(`${returnUrlFor(r)}&confirmed=1`, 303);
}
