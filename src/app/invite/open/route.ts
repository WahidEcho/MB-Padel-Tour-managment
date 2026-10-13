import { NextResponse } from "next/server";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { sameOrigin, setInviteCookie } from "@/lib/orgs/invites";
import { isInviteTokenShaped } from "@/lib/orgs/inviteToken";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

/**
 * Where an invite email's link lands: `/invite/open#t=<token>`. The token is in
 * the fragment, which the browser never sends to a server, so it reaches no
 * access log, proxy, link scanner's request or Referer. This page reads it, wipes
 * it from the address bar and history, and hands it over in a same-origin POST.
 * A query-string token (`?t=`) is never read.
 */
export async function GET() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Move Score invitation</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#111}p{max-width:22rem;text-align:center;padding:0 1rem}</style>
</head><body>
<form id="f" method="post" action="/invite/open"><input type="hidden" name="t" value=""></form>
<p id="m">Opening your invitation…</p>
<noscript><p>Turn on JavaScript to open this invitation.</p></noscript>
<script>
(function () {
  var m = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash || "");
  try { history.replaceState(null, "", location.pathname); } catch (e) {}
  if (!m) { location.replace("/invite?error=invalid"); return; }
  var f = document.getElementById("f");
  f.elements.t.value = m[1];
  f.submit();
})();
</script>
</body></html>`;
  return new NextResponse(html, { headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * The hand-over from the page above. The token moves straight into an httpOnly
 * cookie and the browser goes on to /invite. Nothing is accepted here: that needs
 * the person to sign in with the invited email and then say yes.
 */
export async function POST(request: Request) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), { status: 303, headers: HEADERS });
  if (!sameOrigin(request)) return to("/invite?error=invalid");
  const rl = await checkRateLimit({ key: `staff-invite-open:${clientIpFrom(request.headers)}`, limit: 30, windowSeconds: 600 });
  if (!rl.allowed) return to("/invite?error=busy");
  const form = await request.formData().catch(() => null);
  const token = form?.get("t");
  if (!isInviteTokenShaped(token)) return to("/invite?error=invalid");
  await setInviteCookie(token);
  return to("/invite");
}
