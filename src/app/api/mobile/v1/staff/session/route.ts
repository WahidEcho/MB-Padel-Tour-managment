import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { clientIpFrom } from "@/lib/ratelimit";
import { staffLoginAttempt } from "@/lib/staffLogin";
import { readJson } from "@/lib/mobile/http";
import { STAFF_APP_HOURS, issueCarry, replacePreviousReferee, resolveStaffToken, signInWithAccessCode } from "@/lib/auth/staff";
import { verifyInstallToken } from "@/lib/mobile/identity";
import { bearerToken } from "@/lib/auth";
import { endRefereeSession } from "@/lib/referees/server";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The app's staff sign-in: an organisation's event code (or, for Move Beyond
 * until they are retired, a shared role password) exchanged for a signed staff
 * token, returned in the body for the app to keep in its secure store and send
 * as `Authorization: Bearer`. Every request with it is checked again: a revoked
 * code fails the next call with 401 and a clear message, and the app keeps its
 * queued points until a new code is entered.
 *
 * Referee PINs (migration 0035, audit H1): every referee code (court, whole-event, master)
 * also needs a referee's 4-digit PIN. Newer apps send `{ code, refereeId, pin }`: the
 * referee picked their own name from the list and the PIN is checked against theirs only.
 * Without a PIN the answer is 401 `{ code: "pin_required", court, master, referees }`
 * (`referees`: `{ id, name, photoUrl }` to pick from, never a phone); a wrong PIN 401
 * `wrong_pin`; 429 `pin_locked` (that referee locked 5 minutes; others unaffected),
 * `pin_paused` (the organisation's wrong-PIN budget, new devices only) or `pin_busy` (this
 * address). Move Score 1.0.1 types "<code> <PIN>" / "<code>-<PIN>" in its one field (or
 * an older build `{ code, pin }`): matched across the code's referees under the
 * organisation's budget only (docs/referees.md). The token then names the referee.
 * Operator (TV) codes need no PIN.
 */
export async function POST(request: Request) {
  const body = await readJson<{ code?: unknown; pin?: unknown; refereeId?: unknown; deviceId?: unknown; previousToken?: unknown; pendingMatchIds?: unknown; openMatchIds?: unknown }>(request);
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
  const pin = typeof body?.pin === "string" || typeof body?.pin === "number" ? String(body.pin).slice(0, 12) : undefined;
  const installationId = verifyInstallToken(request.headers.get("x-install-token"));
  const refereeId = typeof body?.refereeId === "string" ? body.refereeId.slice(0, 40) : undefined;
  const r = await signInWithAccessCode(code, STAFF_APP_HOURS, { pin, refereeId, ip, via: "app", installationId, deviceKey: installationId ? `app:${installationId}` : null });
  if (!r.ok) {
    // Only failures stay counted against the brakes (src/lib/staffLogin.ts). A right court
    // code without its PIN is not a failed guess: the PIN has brakes of its own.
    const pinBrake = r.reason === "pin_locked" || r.reason === "pin_paused" || r.reason === "pin_busy";
    if (r.reason === "unavailable" || r.reason === "pin_required" || r.reason === "wrong_pin" || pinBrake) await gate.refund();
    if (pinBrake) {
      return NextResponse.json(
        { error: r.error, code: r.reason },
        { status: 429, headers: { "Retry-After": String(r.retryAfterSeconds ?? 300), ...NO_STORE } },
      );
    }
    const pinCase = r.reason === "pin_required" || r.reason === "wrong_pin";
    return NextResponse.json(
      pinCase
        ? { error: r.error, code: r.reason, court: r.court ? { name: r.court } : null, master: Boolean(r.master), ...(r.referees ? { referees: r.referees } : {}) }
        : { error: r.error },
      { status: 401, headers: NO_STORE },
    );
  }
  await gate.refund();
  // A carry-over token is never a previous credential (audit L2): the app keeps its carries itself.
  const resolved = previousToken ? await resolveStaffToken(previousToken) : null;
  const previous = resolved?.ok && !resolved.staff.scopeMatchIds ? resolved : null;
  const scoringId = typeof body?.deviceId === "string" && body.deviceId.length <= 80 ? body.deviceId : null;
  const carry = previous?.ok
    ? await issueCarry(previous.staff, r.reach, { pending: ids(body?.pendingMatchIds), open: ids(body?.openMatchIds) }, [installationId, scoringId])
    : null;
  if (previous?.ok) await replacePreviousReferee(previous.staff, Boolean(carry));
  // Never the code itself: which code (by id) and which organisation.
  await audit({
    organization_id: r.orgId,
    actor_role: r.role,
    action: "LOGIN",
    entity_type: r.codeId ? "organization_code" : undefined,
    entity_id: r.codeId,
    actor_referee: r.referee,
    new_value: { via: "app", kind: r.kind, ...(r.court ? { court: r.court.name } : {}), ...(r.referee ? { referee: r.referee.name, referee_id: r.referee.id, role: r.referee.role } : {}) },
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
      // New (migration 0035): the referee signed in with their PIN; 1.0.1 ignores it.
      referee: r.referee ? { name: r.referee.name, role: r.referee.role } : null,
      // New: the old court's code for the matches this phone still holds (null when none); 1.0.1 ignores it.
      carry: carry ? { token: carry.token, matchIds: carry.matchIds, court: carry.court, expiresAt: carry.expiresAt } : null,
    },
    { headers: NO_STORE },
  );
}

/**
 * Signing out in the app (newer apps; 1.0.1 only forgets its token): a referee signed in
 * with their PIN leaves "On court now" at once. The token itself still lapses on its own.
 */
export async function DELETE(request: Request) {
  const token = bearerToken(request.headers);
  const r = token ? await resolveStaffToken(token) : null;
  if (r?.ok && r.staff.referee) await endRefereeSession(r.staff.referee.sessionId, "signed_out");
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
