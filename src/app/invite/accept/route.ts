import { NextResponse } from "next/server";
import { acceptPendingInvite, sameOrigin } from "@/lib/orgs/invites";
import { finishStaffSignIn, setStaffCookie, STAFF_WEB_HOURS } from "@/lib/auth/staff";
import { staffHome } from "@/lib/auth/staffRedirect";
import { audit } from "@/lib/audit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * "Accept" on "Join <organisation> as <role>?" (/invite, after a sign-in with the
 * invited email). A form POST from this site only: the membership is written for
 * the person the server sealed at their sign-in, for the invite in this browser,
 * and the console opens for that organisation.
 */
export async function POST(request: Request) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), { status: 303, headers: NO_STORE });
  if (!sameOrigin(request)) return to("/invite?error=invalid");
  const r = await acceptPendingInvite();
  if (!r.ok || !r.userId) return to(`/invite?error=${r.ok ? "invalid" : r.reason}`);
  const done = await finishStaffSignIn(r.userId, r.orgId);
  if (!done.ok) return to(`/login?error=${done.reason}`);
  await setStaffCookie(done.token, STAFF_WEB_HOURS);
  await audit({ organization_id: done.org.id, actor_role: "user", actor_user_id: r.userId, action: "LOGIN", new_value: { via: "web", kind: "member", method: "invite" } });
  return to(staffHome(done.org.role === "owner" ? "admin" : done.org.role));
}
