/**
 * Calls for assistance (migration 0035), server side. A court referee (court code +
 * PIN) taps "Call for assistance"; every master referee on duty for that court's
 * events gets an alert (push to their phones, high priority, sound; plus the live
 * banner of the web console and the app); the first "On my way" acknowledges it with
 * the master's name, which the court referee sees; a master (or the organiser) closes
 * it as resolved. One open call per physical court: more taps join it (deduped), and
 * new calls per court are rate-limited. Staff and the organiser only: nothing here is
 * ever on a TV, a public page or a public API. Pure rules: rules.ts.
 */
import { db } from "../supabase";
import { takeRateLimit } from "../ratelimit";
import { courtKey } from "../orgs/courtScope";
import { isUuid } from "../orgs/roles";
import { sendExpo, type ExpoMessage } from "../notify/drain";
import { alertLang, aw } from "../notify/i18n";
import type { StaffPrincipal } from "../auth/staff";
import { mastersOnDuty } from "./server";
import { matchDayRules } from "../matchday/rules";
import { CALLS_PER_COURT, TAP_DEDUPE_SECONDS, assistanceMessage, isOpenCall, nextCallStatus, shouldRealert, type CallAction, type CallStatus } from "./rules";

export interface AssistanceCall {
  id: string;
  organization_id: string;
  event_group_id: string | null;
  tournament_id: string | null;
  match_id: string | null;
  court_name: string;
  court_key: string;
  scope_key: string;
  code_id: string | null;
  requested_by: string | null;
  requested_by_name: string;
  status: CallStatus;
  requested_at: string;
  taps: number;
  last_tap_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledged_by_name: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  alerted: number;
}
export const CALL_COLS =
  "id, organization_id, event_group_id, tournament_id, match_id, court_name, court_key, scope_key, code_id, requested_by, requested_by_name, status, requested_at, taps, last_tap_at, acknowledged_at, acknowledged_by, acknowledged_by_name, resolved_at, resolved_by, resolved_by_name, alerted";

/** What the phones and the console get: no organisation ids, no code ids. */
export function publicCall(c: AssistanceCall) {
  return {
    id: c.id,
    court: c.court_name,
    tournamentId: c.tournament_id,
    matchId: c.match_id,
    status: c.status,
    requestedBy: c.requested_by_name,
    requestedAt: c.requested_at,
    acknowledgedBy: c.acknowledged_by_name,
    acknowledgedAt: c.acknowledged_at,
    resolvedBy: c.resolved_by_name,
    resolvedAt: c.resolved_at,
  };
}
export type PublicCall = ReturnType<typeof publicCall>;

export type CallOutcome = { ok: true; call: AssistanceCall; deduped?: boolean } | { ok: false; status: number; error: string; code: string; retryAfterSeconds?: number };

const refusal = (status: number, code: string, error: string, retryAfterSeconds?: number): CallOutcome => ({ ok: false, status, code, error, retryAfterSeconds });

/** A court referee signed in with their PIN: who may call for assistance. */
export function isCourtReferee(staff: StaffPrincipal): boolean {
  return staff.kind === "code" && Boolean(staff.scopeCourt && staff.referee && !staff.scopeMatchIds);
}
export function isMasterReferee(staff: StaffPrincipal): boolean {
  return staff.kind === "code" && staff.referee?.role === "master_referee" && Array.isArray(staff.scopeTournamentIds);
}
/** The organiser's own staff (members and Move Beyond's shared admin/manager passwords). */
export function isOrganiser(staff: StaffPrincipal): boolean {
  return staff.kind !== "code" && (staff.role === "admin" || staff.role === "manager");
}

async function openCallAt(orgId: string, scopeKey: string, key: string): Promise<AssistanceCall | null> {
  const { data } = await db()
    .from("assistance_calls")
    .select(CALL_COLS)
    .eq("organization_id", orgId)
    .eq("scope_key", scopeKey)
    .eq("court_key", key)
    .in("status", ["open", "acknowledged"])
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as AssistanceCall | null) ?? null;
}

/** Sends the alert to the master referees on duty for the call's events. Returns how many phones it went to. */
export async function alertMasters(call: AssistanceCall): Promise<number> {
  const duty = await mastersOnDuty(call.organization_id, { eventGroupId: call.event_group_id, tournamentId: call.tournament_id });
  if (!duty.installationIds.length) return 0;
  const { data } = await db()
    .from("push_devices")
    .select("id, expo_push_token, locale")
    .in("installation_id", duty.installationIds.slice(0, 200))
    .is("disabled_at", null)
    .not("expo_push_token", "is", null);
  const devices = (data ?? []) as { id: string; expo_push_token: string; locale?: string | null }[];
  if (!devices.length) return 0;
  // In each phone's language (English: the shared wording the web console shows too).
  const words = (locale: string | null | undefined) => {
    const lang = alertLang(locale);
    return lang === "en"
      ? { title: "Call for assistance", body: assistanceMessage(call.requested_by_name, call.court_name) }
      : { title: aw(lang, "assistance"), body: aw(lang, "assistanceBody", { name: call.requested_by_name.trim(), court: call.court_name.trim() }) };
  };
  const messages: ExpoMessage[] = devices.map((d) => ({
    to: d.expo_push_token,
    ...words(d.locale),
    data: { url: "movescore://referee/master", kind: "assistance", callId: call.id },
    sound: "default",
    channelId: "assistance",
    priority: "high",
    interruptionLevel: "time-sensitive",
    ttl: 600,
  }));
  try {
    const tickets = await sendExpo(messages);
    return tickets.filter((t) => t.status === "ok").length;
  } catch (err) {
    console.error("[assistance] push failed", (err as Error).message);
    return 0;
  }
}

/**
 * "Call for assistance" from a court referee (court code + PIN). One open call per
 * physical court: a tap while one is open joins it (a tap within TAP_DEDUPE_SECONDS
 * is the same tap; later taps re-alert at most once a minute). New calls per court:
 * at most CALLS_PER_COURT per window.
 */
/**
 * Whether "Call master referee" (Admin → Scoring features, `features.callMaster`) is on
 * for a court referee (audit L1): the match's own tournament when the call names one,
 * otherwise any of the court's events. Enforced here, not only by the consoles hiding the
 * button.
 */
export async function callMasterEnabled(staff: Pick<StaffPrincipal, "scopeCourt">, tournamentId?: string | null): Promise<boolean> {
  const ids = tournamentId ? [tournamentId] : (staff.scopeCourt?.tournamentIds ?? []);
  if (!ids.length) return false;
  const { data } = await db().from("tournaments").select("id, sport, match_day_rules").in("id", ids.slice(0, 80));
  return ((data ?? []) as { sport: string | null; match_day_rules: unknown }[]).some((t) => matchDayRules(t.match_day_rules, t).features.callMaster);
}

export async function requestAssistance(staff: StaffPrincipal, opts: { matchId?: string | null; tournamentId?: string | null } = {}, nowMs = Date.now()): Promise<CallOutcome> {
  if (!isCourtReferee(staff)) return refusal(403, "court_referee_only", "Only a court referee signed in with their PIN can call for assistance.");
  if (!(await callMasterEnabled(staff, opts.tournamentId ?? null))) {
    return refusal(409, "feature_off", "Call master referee is switched off for this event. Call the desk.");
  }
  const court = staff.scopeCourt!;
  const referee = staff.referee!;
  const scopeKey = court.eventGroupId ?? staff.scopeTournamentId ?? court.tournamentIds[0] ?? null;
  if (!scopeKey) return refusal(409, "no_event", "This court code has no event.");
  const key = courtKey(court.name);
  const tournamentId = opts.tournamentId && court.tournamentIds.includes(opts.tournamentId) ? opts.tournamentId : (court.withCourt[0] ?? court.tournamentIds[0] ?? null);
  const nowIso = new Date(nowMs).toISOString();

  const tap = async (open: AssistanceCall): Promise<CallOutcome> => {
    if (nowMs - Date.parse(open.last_tap_at) < TAP_DEDUPE_SECONDS * 1000) return { ok: true, call: open, deduped: true };
    const realert = shouldRealert(open, nowMs);
    const { data } = await db()
      .from("assistance_calls")
      .update({ taps: open.taps + 1, last_tap_at: nowIso })
      .eq("id", open.id)
      .eq("taps", open.taps)
      .select(CALL_COLS)
      .maybeSingle();
    const updated = (data as AssistanceCall | null) ?? open;
    if (data && realert) {
      const n = await alertMasters(updated);
      if (n) await db().from("assistance_calls").update({ alerted: updated.alerted + n }).eq("id", updated.id);
    }
    return { ok: true, call: updated, deduped: true };
  };

  const open = await openCallAt(staff.orgId, scopeKey, key);
  if (open) return tap(open);

  const gate = await takeRateLimit({ key: `staff-assist:${scopeKey}:${key}`, ...CALLS_PER_COURT });
  if (!gate.allowed) return refusal(429, "too_many_calls", "Too many calls from this court. The master referees already know; wait a few minutes.", gate.retryAfterSeconds);

  const { data, error } = await db()
    .from("assistance_calls")
    .insert({
      organization_id: staff.orgId,
      event_group_id: court.eventGroupId,
      tournament_id: tournamentId,
      match_id: isUuid(opts.matchId) ? opts.matchId : null,
      court_name: court.name,
      court_key: key,
      scope_key: scopeKey,
      code_id: staff.codeId,
      requested_by: referee.id,
      requested_by_name: referee.name,
      status: "open",
      requested_at: nowIso,
      last_tap_at: nowIso,
    })
    .select(CALL_COLS)
    .single();
  if (error || !data) {
    // Another tap made it first (one open call per court): join that one.
    const raced = await openCallAt(staff.orgId, scopeKey, key);
    if (raced) return { ok: true, call: raced, deduped: true };
    return refusal(500, "failed", "The call could not be sent. Try again, or call the desk.");
  }
  const call = data as AssistanceCall;
  const alerted = await alertMasters(call);
  if (alerted) await db().from("assistance_calls").update({ alerted }).eq("id", call.id);
  return { ok: true, call: { ...call, alerted } };
}

/** Whether a master referee covers a call (its events). */
export function masterCovers(staff: Pick<StaffPrincipal, "orgId" | "scopeTournamentIds">, call: Pick<AssistanceCall, "organization_id" | "tournament_id">): boolean {
  return call.organization_id === staff.orgId && Boolean(call.tournament_id && staff.scopeTournamentIds?.includes(call.tournament_id));
}

/** "On my way", "Resolved" (master referees, the organiser) and "Cancel" (the court referee who called). */
export async function actOnCall(staff: StaffPrincipal, callId: string, action: CallAction, nowMs = Date.now()): Promise<CallOutcome> {
  if (!isUuid(callId)) return refusal(404, "not_found", "Not found");
  const { data } = await db().from("assistance_calls").select(CALL_COLS).eq("id", callId).eq("organization_id", staff.orgId).maybeSingle();
  const call = data as AssistanceCall | null;
  if (!call) return refusal(404, "not_found", "Not found");
  let who: "master" | "court" | "staff" | null = null;
  if (isMasterReferee(staff) && masterCovers(staff, call)) who = "master";
  else if (isCourtReferee(staff) && call.code_id === staff.codeId) who = "court";
  else if (isOrganiser(staff)) who = "staff";
  // Not theirs: the same answer as a call that does not exist.
  if (!who) return refusal(404, "not_found", "Not found");
  const next = nextCallStatus(call.status, action, who);
  if (!next) return refusal(409, isOpenCall(call.status) ? "not_allowed" : "closed", isOpenCall(call.status) ? "Not allowed" : "This call is already closed.");
  const nowIso = new Date(nowMs).toISOString();
  const name = staff.referee?.name ?? (staff.kind === "member" ? "The organiser" : "Tournament desk");
  const patch: Record<string, unknown> = { status: next };
  if (next === "acknowledged") Object.assign(patch, { acknowledged_at: nowIso, acknowledged_by: staff.referee?.id ?? null, acknowledged_by_name: name });
  if (next === "resolved" || next === "cancelled") Object.assign(patch, { resolved_at: nowIso, resolved_by: staff.referee?.id ?? null, resolved_by_name: name });
  // Compare-and-set: two masters tapping "On my way" at once, one wins.
  const { data: changed } = await db().from("assistance_calls").update(patch).eq("id", call.id).eq("status", call.status).select(CALL_COLS).maybeSingle();
  if (!changed) return refusal(409, "changed", "Someone else answered this call first.");
  return { ok: true, call: changed as AssistanceCall };
}

/** The open calls a master referee covers (oldest first), and the ones closed in the last half hour. */
export async function callsForMaster(staff: StaffPrincipal, nowMs = Date.now()): Promise<{ open: AssistanceCall[]; recent: AssistanceCall[] }> {
  const ids = staff.scopeTournamentIds ?? [];
  if (!ids.length) return { open: [], recent: [] };
  const since = new Date(nowMs - 30 * 60_000).toISOString();
  const [{ data: open }, { data: recent }] = await Promise.all([
    db().from("assistance_calls").select(CALL_COLS).eq("organization_id", staff.orgId).in("tournament_id", ids).in("status", ["open", "acknowledged"]).order("requested_at").limit(50),
    db().from("assistance_calls").select(CALL_COLS).eq("organization_id", staff.orgId).in("tournament_id", ids).in("status", ["resolved", "cancelled"]).gte("resolved_at", since).order("resolved_at", { ascending: false }).limit(20),
  ]);
  return { open: (open ?? []) as AssistanceCall[], recent: (recent ?? []) as AssistanceCall[] };
}

/** The court referee's own court: its open call, or the last one closed in the past two minutes. */
export async function callForCourt(staff: StaffPrincipal, nowMs = Date.now()): Promise<AssistanceCall | null> {
  if (!isCourtReferee(staff)) return null;
  const court = staff.scopeCourt!;
  const scopeKey = court.eventGroupId ?? staff.scopeTournamentId ?? court.tournamentIds[0] ?? null;
  if (!scopeKey) return null;
  const open = await openCallAt(staff.orgId, scopeKey, courtKey(court.name));
  if (open) return open;
  const { data } = await db()
    .from("assistance_calls")
    .select(CALL_COLS)
    .eq("organization_id", staff.orgId)
    .eq("scope_key", scopeKey)
    .eq("court_key", courtKey(court.name))
    .gte("resolved_at", new Date(nowMs - 2 * 60_000).toISOString())
    .order("resolved_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as AssistanceCall | null) ?? null;
}

/** Every call of the organisation, newest first (Admin → Referees → Calls for assistance). */
export async function callLog(orgId: string, limit = 300): Promise<AssistanceCall[]> {
  const { data } = await db().from("assistance_calls").select(CALL_COLS).eq("organization_id", orgId).order("requested_at", { ascending: false }).limit(limit);
  return (data ?? []) as AssistanceCall[];
}
