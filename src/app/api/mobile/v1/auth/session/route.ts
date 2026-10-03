import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { appleRefreshToken, authClient, sealToken } from "@/lib/auth/users";
import { readJson } from "@/lib/mobile/http";

/**
 * Sign in with Apple or Google. Optional: guests keep every feature except
 * syncing across phones and linking a player code. There is no age question (it
 * was dropped with player codes, which junior players use); an older build's
 * `ageConfirmed` field is ignored, and nothing about age is stored.
 */
export async function POST(request: Request) {
  const rl = await checkRateLimit({ key: `signin:${clientIpFrom(request.headers)}`, limit: 60, windowSeconds: 600 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many sign-ins from this network. Try again shortly." }, { status: 429 });
  const body = await readJson<{
    provider?: "apple" | "google";
    idToken?: string;
    nonce?: string;
    authorizationCode?: string;
    displayName?: string;
  }>(request);
  if (!body) return NextResponse.json({ error: "provider must be apple or google" }, { status: 400 });
  if (body.provider !== "apple" && body.provider !== "google") return NextResponse.json({ error: "provider must be apple or google" }, { status: 400 });
  if (!body.idToken) return NextResponse.json({ error: "idToken required" }, { status: 400 });
  // Apple tokens carry the hash of a one-time nonce the phone chose, so a token lifted
  // from elsewhere cannot be replayed here. The Google Sign-In library the app uses
  // (v16, original API) cannot set a nonce, so for Google it stays optional.
  if (body.provider === "apple" && !body.nonce) return NextResponse.json({ error: "nonce required" }, { status: 400 });

  const { data, error } = await authClient().auth.signInWithIdToken({
    provider: body.provider,
    token: body.idToken,
    ...(body.nonce ? { nonce: body.nonce } : {}),
  });
  if (error || !data.session || !data.user) {
    return NextResponse.json({ error: "Sign-in was not accepted. Try again." }, { status: 401 });
  }
  const meta = (data.user.user_metadata ?? {}) as { full_name?: string; name?: string };
  const displayName = (body.displayName || meta.full_name || meta.name || "").trim().slice(0, 60) || null;
  const row: Record<string, unknown> = {
    auth_user_id: data.user.id,
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
      userId: data.user.id,
      displayName,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
