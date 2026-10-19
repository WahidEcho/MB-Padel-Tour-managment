import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { clientIpFrom } from "@/lib/ratelimit";
import { staffLoginAttempt } from "@/lib/staffLogin";
import { readJson } from "@/lib/mobile/http";
import { STAFF_APP_HOURS, issueCarry, resolveStaffToken, signInWithAccessCode } from "@/lib/auth/staff";

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
  const body = await readJson<{ code?: unknown; previousToken?: unknown; pendingMatchIds?: unknown; openMatchIds?: unknown }>(request);
  const code = typeof body?.code === "string" ? body.code.slice(0, 200) : "";
  // Switching courts (newer apps; 1.0.1 sends none of these): the token it had, and the
  // matches it still holds unsent points of (pending) or has unfinished (open). The old
  // court's code keeps reaching just those through a carry-over token (issueCarry).
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 25) : []);
  const previousToken = typeof body?.previousToken === "string" && body.previousToken.length < 2000 ? body.previousToken : null;
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
  const previous = previousToken ? await resolveStaffToken(previousToken) : null;
  const carry = previous?.ok ? await issueCarry(previous.staff, r.reach, { pending: ids(body?.pendingMatchIds), open: ids(body?.openMatchIds) }) : null;
  // Never the code itself: which code (by id) and which organisation.
  await audit({
    organization_id: r.orgId,
    actor_role: r.role,
    action: "LOGIN",
    entity_type: r.codeId ? "organization_code" : undefined,
    entity_id: r.codeId,
    new_value: { via: "app", kind: r.kind, ...(r.court ? { court: r.court.name } : {}) },
  });
  return NextResponse.json(
    {
      token: r.token,
      role: r.role,
      expiresAt: r.expiresAt,
      organization: { name: r.orgName, slug: r.orgSlug },
      scope: r.scopeTournamentId ? { tournamentId: r.scopeTournamentId } : null,
      // New: a court referee code's court (null otherwise); 1.0.1 ignores it.
      court: r.court ? { name: r.court.name } : null,
      label: r.label,
      // New: the old court's code for the matches this phone still holds (null when none); 1.0.1 ignores it.
      carry: carry ? { token: carry.token, matchIds: carry.matchIds, court: carry.court, expiresAt: carry.expiresAt } : null,
    },
    { headers: NO_STORE },
  );
}
