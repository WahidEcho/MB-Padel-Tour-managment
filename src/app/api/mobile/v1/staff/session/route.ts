import { NextResponse } from "next/server";
import { APP_SESSION_HOURS, createSessionToken, roleForPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clientIpFrom } from "@/lib/ratelimit";
import { staffLoginAllowed } from "@/lib/staffLogin";
import { readJson } from "@/lib/mobile/http";

/**
 * The app's staff sign-in: the same access codes as the website, exchanged for
 * the same signed role token, returned in the body for the app to keep in its
 * secure store and send as `Authorization: Bearer`.
 */
export async function POST(request: Request) {
  const gate = await staffLoginAllowed(clientIpFrom(request.headers));
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many attempts from this network. Wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds), "Cache-Control": "no-store" } },
    );
  }
  const body = await readJson<{ code?: string }>(request);
  const code = String(body?.code ?? "").slice(0, 200);
  const role = code ? roleForPassword(code) : null;
  if (!role) return NextResponse.json({ error: "Wrong access code." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  await audit({ action: "LOGIN", actor_role: role, new_value: { via: "app" } });
  const expiresAt = new Date(Date.now() + APP_SESSION_HOURS * 3600_000).toISOString();
  return NextResponse.json({ token: createSessionToken(role, APP_SESSION_HOURS), role, expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
