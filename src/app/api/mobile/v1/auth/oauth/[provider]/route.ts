import { NextResponse } from "next/server";
import { authProviders } from "@/lib/auth/users";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { isAppRedirect, isBrowserSignInProvider, isCodeChallenge, redirectWithError, supabaseAuthorizeUrl } from "@/lib/mobile/oauth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Start of browser sign-in. The app opens this URL in its in-app browser sheet
 * (ASWebAuthenticationSession / Custom Tabs) with its redirect and PKCE challenge;
 * this route sends the sheet on to Supabase's authorize URL. Anything wrong goes
 * back to the app's redirect as `?error=`, so the sheet closes and the app says why.
 *
 *   GET /api/mobile/v1/auth/oauth/google?redirect_to=movescore://auth/callback&code_challenge=…
 */
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const q = new URL(request.url).searchParams;
  const redirectTo = q.get("redirect_to");
  const challenge = q.get("code_challenge");
  if (!isAppRedirect(redirectTo)) return NextResponse.json({ error: "redirect_to must be the app's sign-in callback" }, { status: 400, headers: NO_STORE });
  const back = (error: string, description: string) => NextResponse.redirect(redirectWithError(redirectTo, error, description), { status: 302, headers: NO_STORE });

  if (!isBrowserSignInProvider(provider)) return back("unsupported_provider", "This sign-in option is not available");
  if (!isCodeChallenge(challenge)) return back("invalid_request", "The app sent an invalid sign-in request. Update Move Score and try again");
  const rl = await checkRateLimit({ key: `oauth:${clientIpFrom(request.headers)}`, limit: 60, windowSeconds: 600 });
  if (!rl.allowed) return back("rate_limited", "Too many sign-ins from this network. Try again shortly");
  if (!(await authProviders())[provider]) return back("provider_disabled", "Google sign-in is not switched on yet");

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return back("server_error", "Sign-in is not available right now");
  return NextResponse.redirect(supabaseAuthorizeUrl(supabaseUrl, { provider, redirectTo, codeChallenge: challenge }), { status: 302, headers: NO_STORE });
}
