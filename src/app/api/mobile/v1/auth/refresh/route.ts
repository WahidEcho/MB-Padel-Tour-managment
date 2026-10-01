import { NextResponse } from "next/server";
import { authClient } from "@/lib/auth/users";
import { readJson } from "@/lib/mobile/http";

/** Trades a refresh token for a new session. Refresh tokens are single-use: keep the new one. */
export async function POST(request: Request) {
  const body = await readJson<{ refreshToken?: string }>(request);
  if (!body?.refreshToken) return NextResponse.json({ error: "refreshToken required" }, { status: 400 });
  const { data, error } = await authClient().auth.refreshSession({ refresh_token: body.refreshToken });
  if (error || !data.session) return NextResponse.json({ error: "Signed out. Sign in again." }, { status: 401 });
  return NextResponse.json(
    { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
