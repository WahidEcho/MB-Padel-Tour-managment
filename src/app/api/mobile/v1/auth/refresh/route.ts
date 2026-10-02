import { NextResponse } from "next/server";
import { authClient } from "@/lib/auth/users";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { readJson } from "@/lib/mobile/http";

/** Trades a refresh token for a new session. Refresh tokens are single-use: keep the new one. */
export async function POST(request: Request) {
  // A phone refreshes about hourly; generous per address, since a venue can share one.
  const rl = await checkRateLimit({ key: `refresh:${clientIpFrom(request.headers)}`, limit: 300, windowSeconds: 600 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  const body = await readJson<{ refreshToken?: string }>(request);
  if (!body?.refreshToken) return NextResponse.json({ error: "refreshToken required" }, { status: 400 });
  const { data, error } = await authClient().auth.refreshSession({ refresh_token: body.refreshToken });
  if (error || !data.session) return NextResponse.json({ error: "Signed out. Sign in again." }, { status: 401 });
  return NextResponse.json(
    { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
