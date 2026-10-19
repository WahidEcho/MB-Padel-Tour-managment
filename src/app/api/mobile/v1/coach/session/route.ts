import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { clientIpFrom } from "@/lib/ratelimit";
import { readJson } from "@/lib/mobile/http";
import { verifyInstallToken } from "@/lib/mobile/identity";
import { bearerToken } from "@/lib/auth";
import { COACH_APP_HOURS, coachLoginAttempt, resolveCoachToken, endCoachSession, signInWithCoachCode } from "@/lib/coaches/server";
import { isCoachTokenShaped } from "@/lib/coaches/token";
import type { MCoachSession } from "@/lib/mobile/contract";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The app's coach sign-in (migration 0037): a team's code (typed, or from its card's QR)
 * exchanged for a coach token `{ token, expiresAt, team, event }`, kept in the secure store
 * and sent as `Authorization: Bearer`. Every device of the team signs in with the same code;
 * the phone (X-Install-Token) is recorded so the team's alerts reach it. A coach token is
 * never a staff token. Brakes: failed attempts only (a right code is refunded), atomic.
 * Answers: 401 { code: wrong_code | code_revoked | code_expired }, 429 too many attempts.
 */
export async function POST(request: Request) {
  const body = await readJson<{ code?: unknown }>(request);
  const code = typeof body?.code === "string" ? body.code.slice(0, 60) : "";
  const ip = clientIpFrom(request.headers);
  const gate = await coachLoginAttempt(ip, code);
  if (!gate.allowed) {
    return NextResponse.json({ error: "Too many attempts. Wait a few minutes and try again.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds), ...NO_STORE } });
  }
  const installationId = verifyInstallToken(request.headers.get("x-install-token"));
  const r = await signInWithCoachCode(code, { hours: COACH_APP_HOURS, via: "app", installationId });
  if (!r.ok) {
    if (r.reason === "unavailable") await gate.refund();
    return NextResponse.json({ error: r.error, code: r.reason }, { status: r.reason === "unavailable" ? 503 : 401, headers: NO_STORE });
  }
  await gate.refund();
  await audit({ organization_id: r.orgId, tournament_id: r.event.tournamentId, actor_role: "coach", action: "COACH_LOGIN", entity_type: "coach_code", entity_id: r.codeId, new_value: { via: "app", team_id: r.team.id, phone: Boolean(installationId) } });
  const out: MCoachSession = { token: r.token, expiresAt: r.expiresAt, team: r.team, event: { name: r.event.name, slug: r.event.slug, timeZone: r.event.timeZone } };
  return NextResponse.json(out, { headers: NO_STORE });
}

/** Signing out on this device: its sign-in ends at once (no more alerts); the team's code keeps working for the others. */
export async function DELETE(request: Request) {
  const token = bearerToken(request.headers);
  const r = token && isCoachTokenShaped(token) ? await resolveCoachToken(token) : null;
  if (r?.ok) await endCoachSession(r.coach.sessionId, "signed_out");
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
