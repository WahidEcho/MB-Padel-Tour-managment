import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { db } from "@/lib/supabase";
import { readJson } from "@/lib/mobile/http";
import { verifyInstallToken } from "@/lib/mobile/identity";
import { entityInScope } from "@/lib/orgs/scope";
import { noteSessionDevice } from "@/lib/referees/server";
import { CALL_COLS, actOnCall, callForCourt, callsForMaster, isCourtReferee, isMasterReferee, isOrganiser, publicCall, requestAssistance, type AssistanceCall } from "@/lib/referees/assistance";
import { audit } from "@/lib/audit";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Calls for assistance (migration 0035), for the web console and the app. Staff only
 * (a court referee or master referee signed in with their PIN, or the organiser);
 * never cached, never on a TV or a public route.
 *
 * GET: a court referee gets its court's call (open, or just closed) with the master's
 * answer; a master referee the open calls of its events (and records this phone for
 * its alerts); the organiser every open call of the organisation.
 * POST { action: "request", matchId? } (court referee), { action: "acknowledge" | "resolve" | "cancel", callId }.
 */
export async function GET(request: Request) {
  const gate = await staffRoute("score_match");
  if (!gate.ok) return gate.response;
  const { staff } = gate;
  if (isMasterReferee(staff)) {
    await noteSessionDevice(staff.referee!, verifyInstallToken(request.headers.get("x-install-token")));
    const { open, recent } = await callsForMaster(staff);
    return NextResponse.json({ role: "master", referee: staff.referee!.name, open: open.map(publicCall), recent: recent.map(publicCall) }, { headers: NO_STORE });
  }
  if (isCourtReferee(staff)) {
    const call = await callForCourt(staff);
    return NextResponse.json({ role: "court", referee: staff.referee!.name, court: staff.scopeCourt!.name, call: call ? publicCall(call) : null }, { headers: NO_STORE });
  }
  if (isOrganiser(staff)) {
    const { data } = await db().from("assistance_calls").select(CALL_COLS).eq("organization_id", staff.orgId).in("status", ["open", "acknowledged"]).order("requested_at").limit(50);
    return NextResponse.json({ role: "organiser", open: ((data ?? []) as AssistanceCall[]).map(publicCall), recent: [] }, { headers: NO_STORE });
  }
  return NextResponse.json({ role: "none" }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const gate = await staffRoute("score_match");
  if (!gate.ok) return gate.response;
  const { staff } = gate;
  const body = await readJson<{ action?: unknown; callId?: unknown; matchId?: unknown }>(request);
  const action = typeof body?.action === "string" ? body.action : "";
  if (action === "request") {
    // The match it is about, only when this court referee reaches it (its court's match).
    const matchId = typeof body?.matchId === "string" ? body.matchId : null;
    const scope = matchId ? await entityInScope(staff, { match: matchId }) : null;
    const out = await requestAssistance(staff, { matchId: scope ? matchId : null, tournamentId: scope?.tournamentId ?? null });
    if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status, headers: { ...NO_STORE, ...(out.retryAfterSeconds ? { "Retry-After": String(out.retryAfterSeconds) } : {}) } });
    if (!out.deduped) {
      await audit({
        tournament_id: out.call.tournament_id,
        organization_id: staff.orgId,
        actor_role: staff.role,
        action: "ASSISTANCE_REQUESTED",
        entity_type: "assistance_call",
        entity_id: out.call.id,
        new_value: { court: out.call.court_name, match_id: out.call.match_id, alerted: out.call.alerted },
      });
    }
    return NextResponse.json({ ok: true, deduped: Boolean(out.deduped), alerted: out.call.alerted, call: publicCall(out.call) }, { status: out.deduped ? 200 : 201, headers: NO_STORE });
  }
  if (action === "acknowledge" || action === "resolve" || action === "cancel") {
    const out = await actOnCall(staff, typeof body?.callId === "string" ? body.callId : "", action);
    if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status, headers: NO_STORE });
    await audit({
      tournament_id: out.call.tournament_id,
      organization_id: staff.orgId,
      actor_role: staff.role,
      action: action === "acknowledge" ? "ASSISTANCE_ACKNOWLEDGED" : action === "resolve" ? "ASSISTANCE_RESOLVED" : "ASSISTANCE_CANCELLED",
      entity_type: "assistance_call",
      entity_id: out.call.id,
      new_value: { court: out.call.court_name },
    });
    return NextResponse.json({ ok: true, call: publicCall(out.call) }, { headers: NO_STORE });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400, headers: NO_STORE });
}
