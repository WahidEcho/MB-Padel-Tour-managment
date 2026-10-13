import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeOAuthCode } from "@/lib/auth/users";
import { getAuthUser, signOutAuth } from "@/lib/auth/accounts";
import { STAFF_OAUTH_COOKIE, openOAuthState } from "@/lib/auth/staffOAuth";
import { staffHome } from "@/lib/auth/staffRedirect";
import { finishStaffSignIn, setStaffCookie, STAFF_WEB_HOURS } from "@/lib/auth/staff";
import { audit } from "@/lib/audit";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { pendingInviteFor } from "@/lib/orgs/invites";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Where Supabase sends the browser back after Google. The code only works with
 * the verifier in this browser's state cookie (PKCE), once. The server checks
 * the resulting session with Supabase Auth itself, then issues its own signed
 * staff cookie for the person's organisation and drops the Supabase session.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), { status: 302, headers: NO_STORE });
  const store = await cookies();
  const state = openOAuthState(store.get(STAFF_OAUTH_COOKIE)?.value);
  store.delete({ name: STAFF_OAUTH_COOKIE, path: "/staff/auth" });

  if (url.searchParams.get("error")) return to(url.searchParams.get("error") === "access_denied" ? "/login" : "/login?error=signin_failed");
  const code = url.searchParams.get("code");
  if (!state || !code || code.length > 200) return to("/login?error=signin_failed");
  const rl = await checkRateLimit({ key: `staff-oauth-cb:${clientIpFrom(request.headers)}`, limit: 30, windowSeconds: 600 });
  if (!rl.allowed) return to("/login?error=2");

  const { data, error } = await exchangeOAuthCode(code, state.verifier);
  if (error || !data.session || !data.user) return to("/login?error=signin_failed");
  // Authoritative: ask Supabase Auth who the session belongs to.
  const me = await getAuthUser(data.session.access_token);
  if (!me.ok || me.data.id !== data.user.id || me.data.is_anonymous) return to("/login?error=signin_failed");

  // An invite opened in this browser is never accepted by the sign-in: when it is this
  // person's (their confirmed email), the next page asks "Join … ?"; otherwise the
  // browser forgets it. Either way the sign-in itself goes ahead as usual.
  const invite = await pendingInviteFor(me.data);
  const done = await finishStaffSignIn(me.data.id);
  await signOutAuth(data.session.access_token).catch(() => false);
  if (done.ok) {
    await setStaffCookie(done.token, STAFF_WEB_HOURS);
    await audit({ organization_id: done.org.id, actor_role: done.org.role, action: "LOGIN", new_value: { via: "web", kind: "member", method: "google" } });
  }
  if (invite?.ok) return to("/invite");
  if (!done.ok) return to(invite ? `/invite?error=${invite.reason}` : `/login?error=${done.reason}`);
  const next = state.next === "/invite" ? null : state.next;
  if (done.choices > 1) return to(`/staff/orgs${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  return to(next || staffHome(done.org.role === "owner" ? "admin" : done.org.role));
}
