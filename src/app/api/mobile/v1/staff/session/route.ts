import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { clientIpFrom } from "@/lib/ratelimit";
import { staffLoginAttempt } from "@/lib/staffLogin";
import { readJson } from "@/lib/mobile/http";
import { STAFF_APP_HOURS, signInWithAccessCode } from "@/lib/auth/staff";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The app's staff sign-in: an organisation's event code (or, for Move Beyond
 * until they are retired, a shared role password) exchanged for a signed staff
 * token, returned in the body for the app to keep in its secure store and send
 * as `Authorization: Bearer`. Every request with it is checked again: a revoked
 * code fails the next call with 401 and a clear message, and the app keeps its
 * queued points until a new code is entered.
 */
export async function POST(request: Request) {
  const body = await readJson<{ code?: unknown }>(request);
  const code = typeof body?.code === "string" ? body.code.slice(0, 200) : "";
  const ip = clientIpFrom(request.headers);
  // Counted before it is checked (atomically); a right code is refunded (src/lib/staffLogin.ts).
  const gate = await staffLoginAttempt(ip, code);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds), ...NO_STORE } },
    );
  }
  const r = await signInWithAccessCode(code, STAFF_APP_HOURS);
  if (!r.ok) {
    // Only failures stay counted against the brakes (src/lib/staffLogin.ts).
    if (r.reason === "unavailable") await gate.refund();
    return NextResponse.json({ error: r.error }, { status: 401, headers: NO_STORE });
  }
  await gate.refund();
  // Never the code itself: which code (by id) and which organisation.
  await audit({
    organization_id: r.orgId,
    actor_role: r.role,
    action: "LOGIN",
    entity_type: r.codeId ? "organization_code" : undefined,
    entity_id: r.codeId,
    new_value: { via: "app", kind: r.kind },
  });
  return NextResponse.json(
    {
      token: r.token,
      role: r.role,
      expiresAt: r.expiresAt,
      organization: { name: r.orgName, slug: r.orgSlug },
      scope: r.scopeTournamentId ? { tournamentId: r.scopeTournamentId } : null,
    },
    { headers: NO_STORE },
  );
}
