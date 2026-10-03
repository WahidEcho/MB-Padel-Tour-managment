import { NextResponse } from "next/server";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { readJson } from "@/lib/mobile/http";
import { refreshAuthSession } from "@/lib/auth/accounts";
import { refreshVerdict, SESSION_RETRY, SESSION_REVOKED } from "@/lib/auth/sessionRules";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Trades a refresh token for a new session. Refresh tokens are single-use: keep the new one.
 *
 * 401 { code: "session_revoked" } only when Supabase refused the token for good
 * (revoked, rotated away, session ended, user gone): the app then signs out.
 * Anything temporary (Supabase unreachable, 5xx, rate limits) is 503/429
 * { code: "session_retry" }: the app keeps its tokens and tries again later.
 */
export async function POST(request: Request) {
  // A phone refreshes about hourly; generous per address, since a venue can share one.
  const rl = await checkRateLimit({ key: `refresh:${clientIpFrom(request.headers)}`, limit: 300, windowSeconds: 600 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Try again shortly.", code: SESSION_RETRY }, { status: 429, headers: NO_STORE });
  const body = await readJson<{ refreshToken?: unknown }>(request);
  if (typeof body?.refreshToken !== "string" || !body.refreshToken || body.refreshToken.length > 2000) {
    return NextResponse.json({ error: "refreshToken required" }, { status: 400, headers: NO_STORE });
  }
  const r = await refreshAuthSession(body.refreshToken);
  if (!r.ok) {
    const verdict = refreshVerdict({ name: r.status === 0 ? "AuthRetryableFetchError" : "AuthApiError", status: r.status, code: r.code ?? undefined, message: r.message });
    if (verdict === "revoked") return NextResponse.json({ error: "Signed out. Sign in again.", code: SESSION_REVOKED }, { status: 401, headers: NO_STORE });
    return NextResponse.json({ error: "Couldn't refresh right now.", code: SESSION_RETRY }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt }, { headers: NO_STORE });
}
