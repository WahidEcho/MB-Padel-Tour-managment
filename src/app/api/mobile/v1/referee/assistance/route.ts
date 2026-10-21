import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { db } from "@/lib/supabase";
import { readJson } from "@/lib/mobile/http";
import { verifyInstallToken } from "@/lib/mobile/identity";
import { entityInScope } from "@/lib/orgs/scope";
import { noteSessionDevice } from "@/lib/referees/server";
import {
  CALL_COLS,
  actOnCall,
  callForCourt,
  callMasterEnabled,
  callsForMaster,
  describeCalls,
  isCourtReferee,
  isMasterReferee,
  isOrganiser,
  publicCall,
  requestAssistance,
  respondToCall,
  tickCall,
  type AssistanceCall,
  type CallOutcome,
} from "@/lib/referees/assistance";
import { isCallAnswer } from "@/lib/referees/rules";
import { audit } from "@/lib/audit";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Calls for assistance (migrations 0035 and 0042), for the web console and the app. Staff
 * only (a court referee or master referee signed in with their PIN, or the organiser);
 * never cached, never on a TV or a public route.
 *
 * GET: a court referee gets its court's call (open, or just closed) with the masters'
 * answers; a master referee the open calls of its events (and records this phone for
 * its alerts); the organiser every open call of the organisation.
 * POST { action: "request", matchId? } (court referee), { action: "respond", callId, answer: "coming" | "declined" }
 * (master referees, 0042), { action: "acknowledge" | "resolve" | "cancel", callId } ("acknowledge" is Move Score
 * 1.0.1's "On my way": the same as Coming).
 *
 * Every call in a reply carries, additively (0042), `going`, `responses` (every master on duty: name, answer
 * coming | declined | none, when; names only, never a phone), `remindersSent`, `escalatedAt`, and on a master's
 * desk `mine`. Reading an open call runs its timed steps (the 30-second reminders, the 2-minute escalation), so
 * the court phone's poll and the masters' desks drive them; the scheduled drain is the backstop.
 */
export async function GET(request: Request) {
  const gate = await staffRoute("score_match");
  if (!gate.ok) return gate.response;
  const { staff } = gate;
  if (isMasterReferee(staff)) {
    await noteSessionDevice(staff.referee!, verifyInstallToken(request.headers.get("x-install-token")));
    const { open, recent } = await callsForMaster(staff);
    const [o, r] = await Promise.all([describeCalls(open, staff.referee!.id), describeCalls(recent, staff.referee!.id)]);
    return NextResponse.json({ role: "master", referee: staff.referee!.name, open: o, recent: r }, { headers: NO_STORE });
  }
  if (isCourtReferee(staff)) {
    const [call, enabled] = await Promise.all([callForCourt(staff), callMasterEnabled(staff)]);
    const [shown] = call ? await describeCalls([call]) : [null];
    // `enabled` (new; older apps ignore it): Call master referee is on for this court's events (409 feature_off otherwise).
    return NextResponse.json({ role: "court", referee: staff.referee!.name, court: staff.scopeCourt!.name, enabled, call: shown ?? null }, { headers: NO_STORE });
  }
  if (isOrganiser(staff)) {
    const { data } = await db().from("assistance_calls").select(CALL_COLS).eq("organization_id", staff.orgId).in("status", ["open", "acknowledged"]).order("requested_at").limit(50);
    const ticked: AssistanceCall[] = [];
    for (const c of (data ?? []) as AssistanceCall[]) ticked.push(await tickCall(c));
    return NextResponse.json({ role: "organiser", open: await describeCalls(ticked), recent: [] }, { headers: NO_STORE });
  }
  return NextResponse.json({ role: "none" }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const gate = await staffRoute("score_match");
  if (!gate.ok) return gate.response;
  const { staff } = gate;
  const body = await readJson<{ action?: unknown; callId?: unknown; matchId?: unknown; answer?: unknown }>(request);
  const action = typeof body?.action === "string" ? body.action : "";
  const mine = isMasterReferee(staff) ? staff.referee!.id : undefined;
  const refused = async (out: Extract<CallOutcome, { ok: false }>) => {
    // already_taken (0042): who took it, and the call as it is now, so the desk shows "Sara is going".
    const extra = out.code === "already_taken" ? { takenBy: out.takenBy ?? null, call: out.call ? ((await describeCalls([out.call], mine))[0] ?? null) : null } : {};
    return NextResponse.json({ error: out.error, code: out.code, ...extra }, { status: out.status, headers: NO_STORE });
  };
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
    const [shown] = await describeCalls([out.call]);
    return NextResponse.json({ ok: true, deduped: Boolean(out.deduped), alerted: out.call.alerted, call: shown ?? publicCall(out.call) }, { status: out.deduped ? 200 : 201, headers: NO_STORE });
  }
  if (action === "respond") {
    const answer = body?.answer;
    if (!isCallAnswer(answer)) return NextResponse.json({ error: "answer must be coming or declined", code: "bad_answer" }, { status: 400, headers: NO_STORE });
    const out = await respondToCall(staff, typeof body?.callId === "string" ? body.callId : "", answer);
    if (!out.ok) return refused(out);
    await audit({
      tournament_id: out.call.tournament_id,
      organization_id: staff.orgId,
      actor_role: staff.role,
      action: answer === "coming" ? "ASSISTANCE_COMING" : "ASSISTANCE_DECLINED",
      entity_type: "assistance_call",
      entity_id: out.call.id,
      new_value: { court: out.call.court_name },
    });
    const [shown] = await describeCalls([out.call], mine);
    return NextResponse.json({ ok: true, call: shown ?? publicCall(out.call) }, { headers: NO_STORE });
  }
  if (action === "acknowledge" || action === "resolve" || action === "cancel") {
    const out = await actOnCall(staff, typeof body?.callId === "string" ? body.callId : "", action);
    if (!out.ok) return refused(out);
    await audit({
      tournament_id: out.call.tournament_id,
      organization_id: staff.orgId,
      actor_role: staff.role,
      action: action === "acknowledge" ? "ASSISTANCE_ACKNOWLEDGED" : action === "resolve" ? "ASSISTANCE_RESOLVED" : "ASSISTANCE_CANCELLED",
      entity_type: "assistance_call",
      entity_id: out.call.id,
      new_value: { court: out.call.court_name },
    });
    const [shown] = await describeCalls([out.call], mine);
    return NextResponse.json({ ok: true, call: shown ?? publicCall(out.call) }, { headers: NO_STORE });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400, headers: NO_STORE });
}
