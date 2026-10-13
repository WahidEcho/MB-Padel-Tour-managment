import { NextResponse } from "next/server";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { setInviteCookie } from "@/lib/orgs/invites";
import { isInviteTokenShaped } from "@/lib/orgs/inviteToken";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/**
 * Where an invite email's link lands. The token moves straight into an httpOnly
 * cookie and the browser goes on to /invite with a clean address bar, so the
 * token is in no further URL, page, history entry or referrer. Nothing is
 * accepted here: that needs the person to sign in with the invited email.
 */
export async function GET(request: Request) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), { status: 303, headers: HEADERS });
  const rl = await checkRateLimit({ key: `staff-invite-open:${clientIpFrom(request.headers)}`, limit: 30, windowSeconds: 600 });
  if (!rl.allowed) return to("/invite?error=busy");
  const token = new URL(request.url).searchParams.get("t");
  if (!isInviteTokenShaped(token)) return to("/invite?error=invalid");
  await setInviteCookie(token);
  return to("/invite");
}
