import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { authProviders } from "@/lib/auth/users";
import { STAFF_OAUTH_COOKIE, sealOAuthState } from "@/lib/auth/staffOAuth";
import { safeNextPath } from "@/lib/auth/staffRedirect";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { siteUrl } from "@/lib/messaging/links";
import { STAFF_WEB_CALLBACK_PATH, isAppRedirect, supabaseAuthorizeUrl } from "@/lib/mobile/oauth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Web staff sign-in with Google, through Supabase Auth's PKCE flow (the same one
 * the app uses). The server makes the verifier and keeps it in a short-lived,
 * httpOnly cookie; Google and Supabase send the browser back to the site's own
 * callback, which trades code + verifier for a session, checks it, and issues
 * the staff cookie. The callback address is built from the configured site, never
 * from the request, and must be exactly the one isAppRedirect allows.
 */
export async function GET(request: Request) {
  const next = safeNextPath(new URL(request.url).searchParams.get("next"));
  const back = (error: string) => NextResponse.redirect(new URL(`/login?error=${error}`, request.url), { status: 302, headers: NO_STORE });

  const rl = await checkRateLimit({ key: `staff-oauth:${clientIpFrom(request.headers)}`, limit: 30, windowSeconds: 600 });
  if (!rl.allowed) return back("2");
  if (!(await authProviders()).google) return back("google_off");
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return back("unavailable");

  const site = siteUrl();
  const redirectTo = `${site}${STAFF_WEB_CALLBACK_PATH}`;
  if (!isAppRedirect(redirectTo, { siteOrigin: site })) return back("unavailable");

  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let state: string;
  try {
    state = sealOAuthState(verifier, next);
  } catch {
    return back("unavailable");
  }
  const res = NextResponse.redirect(supabaseAuthorizeUrl(supabaseUrl, { provider: "google", redirectTo, codeChallenge: challenge }), { status: 302, headers: NO_STORE });
  res.cookies.set(STAFF_OAUTH_COOKIE, state, {
    httpOnly: true,
    // Lax: the browser comes back from Google/Supabase with a top-level GET, which carries it.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/staff/auth",
    maxAge: 600,
  });
  return res;
}
