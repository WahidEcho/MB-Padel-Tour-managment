import { NextResponse } from "next/server";
import type { Session, User } from "@supabase/supabase-js";
import { db } from "@/lib/supabase";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { appleRefreshToken, authClient, exchangeOAuthCode, sealToken } from "@/lib/auth/users";
import { readJson } from "@/lib/mobile/http";
import { isBrowserSignInProvider, isCodeVerifier } from "@/lib/mobile/oauth";

/**
 * Sign in with Apple or Google. Optional: guests keep every feature except
 * syncing across phones and linking a player code. There is no age question (it
 * was dropped with player codes, which junior players use); an older build's
 * `ageConfirmed` field is ignored, and nothing about age is stored.
 *
 * Two ways in:
 * - `{ provider: "apple", idToken, nonce, authorizationCode }` — native Sign in with Apple (iPhone).
 * - `{ provider: "google", code, codeVerifier }` — the code Supabase sent back to the app after
 *   Google sign-in in the in-app browser sheet, with the PKCE verifier only this phone holds.
 *   (`{ provider: "google", idToken }` from a native Google library is still accepted.)
 */
export async function POST(request: Request) {
  const rl = await checkRateLimit({ key: `signin:${clientIpFrom(request.headers)}`, limit: 60, windowSeconds: 600 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many sign-ins from this network. Try again shortly." }, { status: 429 });
  const body = await readJson<{
    provider?: "apple" | "google";
    idToken?: string;
    nonce?: string;
    authorizationCode?: string;
    code?: string;
    codeVerifier?: string;
    displayName?: string;
  }>(request);
  if (!body) return NextResponse.json({ error: "provider must be apple or google" }, { status: 400 });
  if (body.provider !== "apple" && body.provider !== "google") return NextResponse.json({ error: "provider must be apple or google" }, { status: 400 });

  let signedIn: { session: Session | null; user: User | null } | null = null;
  if (body.code !== undefined) {
    // Browser sign-in: the code alone is useless without the verifier this phone made.
    if (!isBrowserSignInProvider(body.provider)) return NextResponse.json({ error: "This provider signs in on the phone, not in the browser." }, { status: 400 });
    if (typeof body.code !== "string" || !body.code || body.code.length > 200) return NextResponse.json({ error: "code required" }, { status: 400 });
    if (!isCodeVerifier(body.codeVerifier)) return NextResponse.json({ error: "codeVerifier required" }, { status: 400 });
    const { data, error } = await exchangeOAuthCode(body.code, body.codeVerifier);
    if (error) return NextResponse.json({ error: "Sign-in expired or was already used. Try again." }, { status: 401 });
    signedIn = data;
  } else {
    if (!body.idToken) return NextResponse.json({ error: "idToken or code required" }, { status: 400 });
    // Apple tokens carry the hash of a one-time nonce the phone chose, so a token lifted
    // from elsewhere cannot be replayed here.
    if (body.provider === "apple" && !body.nonce) return NextResponse.json({ error: "nonce required" }, { status: 400 });
    const { data, error } = await authClient().auth.signInWithIdToken({
      provider: body.provider,
      token: body.idToken,
      ...(body.nonce ? { nonce: body.nonce } : {}),
    });
    if (!error) signedIn = data;
  }
  if (!signedIn?.session || !signedIn.user) {
    return NextResponse.json({ error: "Sign-in was not accepted. Try again." }, { status: 401 });
  }
  const { session, user } = signedIn;

  const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string; avatar_url?: string; picture?: string };
  const displayName = (body.displayName || meta.full_name || meta.name || "").trim().slice(0, 60) || null;
  const avatar = meta.avatar_url || meta.picture || null;
  const avatarUrl = typeof avatar === "string" && /^https:\/\//.test(avatar) ? avatar : null;
  const row: Record<string, unknown> = {
    auth_user_id: user.id,
    provider: body.provider,
    updated_at: new Date().toISOString(),
  };
  if (displayName) row.display_name = displayName;
  if (body.provider === "apple" && body.authorizationCode) {
    const refresh = await appleRefreshToken(body.authorizationCode);
    if (refresh) row.apple_refresh_token_enc = sealToken(refresh);
  }
  await db().from("app_users").upsert(row, { onConflict: "auth_user_id" });
  return NextResponse.json(
    {
      userId: user.id,
      displayName,
      email: user.email ?? null,
      avatarUrl,
      provider: body.provider,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
