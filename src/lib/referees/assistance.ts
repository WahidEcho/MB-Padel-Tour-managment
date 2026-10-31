/**
 * Calls for assistance (migrations 0035 and 0042), server side. A chair umpire (court
 * code + PIN) taps "Call for assistance"; every master referee on duty for that court's
 * events gets a time-sensitive alert (push to their phones, with Coming / Decline
 * buttons; plus the live banner of the web console and the app). Each master answers:
 * - Coming: the first one takes the call (compare-and-set), the chair umpire sees
 *   "Sara is coming to Court 2", every other master on duty gets "Master referee Sara is
 *   going to the emergency call at Court 2", and the reminders stop;
 * - Decline: the call stays open for the others; that master gets no more reminders.
 * While nobody has taken it, every REMINDER_SECONDS the masters who have not declined get
 * the alert again (one reminder per window: claimed with a compare-and-set on
 * `reminders_sent`, by whoever reads the call first: the court phone's poll, a master's
 * desk or the scheduled drain), and after ESCALATE_SECONDS (or once every master on duty
 * declined) the organisation's owners and admins are alerted once (push + staff_alert
 * email). A master (or the organiser) closes it as resolved. One open call per physical
 * court: more taps join it, new calls per court are rate-limited. Staff and the organiser
 * only: nothing here is ever on a TV, a public page or a public API. Pure rules: rules.ts;
 * words: callWords.ts.
 */
import { db } from "../supabase";
import { takeRateLimit } from "../ratelimit";
import { courtKey } from "../orgs/courtScope";
import { isUuid } from "../orgs/roles";
import { sendExpo, type ExpoMessage } from "../notify/drain";
import type { StaffPrincipal } from "../auth/staff";
import { mastersOnDuty } from "./server";
import { matchDayRules } from "../matchday/rules";
import {
  CALLS_PER_COURT,
  ESCALATE_SECONDS,
  TAP_DEDUPE_SECONDS,
  escalationDue,
  isOpenCall,
  masterAnswers,
  nextCallStatus,
  reminderDue,
  reminderRecipients,
  shouldRealert,
  type CallAction,
  type CallAnswer,
  type CallResponse,
  type CallStatus,
  type MasterAnswerRow,
} from "./rules";
import { callLang, callWord, type CallLang, type CallWordKey } from "./callWords";

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
  // 0042
  last_alert_at: string | null;
  reminders_sent: number;
  escalated_at: string | null;
}
export const CALL_COLS =
  "id, organization_id, event_group_id, tournament_id, match_id, court_name, court_key, scope_key, code_id, requested_by, requested_by_name, status, requested_at, taps, last_tap_at, acknowledged_at, acknowledged_by, acknowledged_by_name, resolved_at, resolved_by, resolved_by_name, alerted, last_alert_at, reminders_sent, escalated_at";

/** What a call's answers add to its public shape: every master on duty with their answer (names only), and the caller's own answer on a master's desk. */
export interface CallExtras {
  answers: MasterAnswerRow[];
  mine?: CallAnswer | null;
}

/**
 * What the phones and the console get: no organisation ids, no code ids, no referee ids,
 * never a phone. Fields after `resolvedAt` are additive (0042); Move Score 1.0.1 reads the
 * ones before.
 */
export function publicCall(c: AssistanceCall, extras?: CallExtras) {
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
    /** The master who said Coming and is on the way (null until then). */
    going: c.status === "acknowledged" ? c.acknowledged_by_name : null,
    /** Every master on duty with their answer: coming | declined | none, and when. */
    responses: extras?.answers ?? [],
    remindersSent: c.reminders_sent ?? 0,
    escalatedAt: c.escalated_at ?? null,
    ...(extras && "mine" in extras ? { mine: extras.mine ?? null } : {}),
  };
}
export type PublicCall = ReturnType<typeof publicCall>;

export type CallOutcome =
  | { ok: true; call: AssistanceCall; deduped?: boolean }
  | { ok: false; status: number; error: string; code: string; retryAfterSeconds?: number; takenBy?: string | null; call?: AssistanceCall };

const refusal = (status: number, code: string, error: string, retryAfterSeconds?: number): CallOutcome => ({ ok: false, status, code, error, retryAfterSeconds });

/** A chair umpire signed in with their PIN: who may call for assistance. */
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

/* ---------------- who is on duty, who answered ---------------- */

interface Duty {
  refereeIds: string[];
  byReferee: Record<string, string[]>;
  roster: { id: string; name: string }[];
}

/** The master referees on duty for a call's events, with their names and their phones. */
async function dutyFor(call: Pick<AssistanceCall, "organization_id" | "event_group_id" | "tournament_id">, nowMs = Date.now()): Promise<Duty> {
  const duty = await mastersOnDuty(call.organization_id, { eventGroupId: call.event_group_id, tournamentId: call.tournament_id }, nowMs);
  if (!duty.refereeIds.length) return { refereeIds: [], byReferee: {}, roster: [] };
  const { data } = await db().from("referees").select("id, name").eq("organization_id", call.organization_id).eq("status", "active").in("id", duty.refereeIds.slice(0, 100));
  const names = new Map(((data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name]));
  const refereeIds = duty.refereeIds.filter((id) => names.has(id));
  return { refereeIds, byReferee: duty.byReferee, roster: refereeIds.map((id) => ({ id, name: names.get(id)! })) };
}

/** The answers given to these calls, by call. */
async function responsesFor(callIds: string[]): Promise<Map<string, CallResponse[]>> {
  const out = new Map<string, CallResponse[]>();
  if (!callIds.length) return out;
  const { data } = await db().from("assistance_responses").select("call_id, referee_id, referee_name, answer, answered_at").in("call_id", callIds.slice(0, 100));
  for (const r of (data ?? []) as { call_id: string; referee_id: string; referee_name: string; answer: CallAnswer; answered_at: string }[]) {
    const list = out.get(r.call_id) ?? [];
    list.push({ refereeId: r.referee_id, name: r.referee_name, answer: r.answer, at: r.answered_at });
    out.set(r.call_id, list);
  }
  return out;
}

/**
 * The public shape of these calls with every master's answer (open calls list every master
 * on duty, "none" for no answer yet; closed ones only those who answered). `mineFor`: the
 * master referee whose desk this is.
 */
export async function describeCalls(calls: AssistanceCall[], mineFor?: string | null): Promise<PublicCall[]> {
  if (!calls.length) return [];
  const responses = await responsesFor(calls.map((c) => c.id));
  const duties = new Map<string, Promise<Duty>>();
  const dutyOf = (c: AssistanceCall) => {
    const key = `${c.organization_id}:${c.event_group_id ?? ""}:${c.tournament_id ?? ""}`;
    if (!duties.has(key)) duties.set(key, dutyFor(c));
    return duties.get(key)!;
  };
  return Promise.all(
    calls.map(async (c) => {
      const r = responses.get(c.id) ?? [];
      const roster = isOpenCall(c.status) ? (await dutyOf(c)).roster : [];
      const extras: CallExtras = { answers: masterAnswers(roster, r) };
      if (mineFor !== undefined) extras.mine = r.find((x) => x.refereeId === mineFor)?.answer ?? null;
      return publicCall(c, extras);
    }),
  );
}

/* ---------------- pushes ---------------- */

type Words = (lang: CallLang) => { title: string; body: string };

/** Sends one push per phone, in each phone's language. Returns how many Expo accepted. */
async function pushTo(installationIds: string[], words: Words, extra: Omit<ExpoMessage, "to" | "title" | "body">): Promise<number> {
  const ids = [...new Set(installationIds)].slice(0, 200);
  if (!ids.length) return 0;
  const { data } = await db().from("push_devices").select("id, expo_push_token, locale, app_version").in("installation_id", ids).is("disabled_at", null).not("expo_push_token", "is", null);
  return sendTo((data ?? []) as Device[], words, extra);
}

type Device = { expo_push_token: string; locale: string | null; app_version?: string | null };

/** Move Score 1.0.3 and later ring calls with their own ringtone (`master_alarm.wav`, channel `assistance_alarm`). */
export function ringsWithAlarm(appVersion: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(appVersion ?? "");
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a > 1 || (a === 1 && (b > 0 || c >= 3));
}

async function sendTo(devices: Device[], words: Words, extra: Omit<ExpoMessage, "to" | "title" | "body">): Promise<number> {
  if (!devices.length) return 0;
  const messages: ExpoMessage[] = devices.map((d) => {
    // A call's alarm on phones that have the ringtone; older phones keep their channel and sound.
    const alarm = extra.channelId === "assistance" && ringsWithAlarm(d.app_version) ? { channelId: "assistance_alarm", sound: "master_alarm.wav" as const } : {};
    return { to: d.expo_push_token, ...words(callLang(d.locale)), ...extra, ...alarm };
  });
  try {
    const tickets = await sendExpo(messages);
    return tickets.filter((t) => t.status === "ok").length;
  } catch (err) {
    console.error("[assistance] push failed", (err as Error).message);
    return 0;
  }
}

const titled = (title: CallWordKey, body: CallWordKey, vars: Record<string, string | number>): Words => (lang) => ({ title: callWord(lang, title, vars), body: callWord(lang, body, vars) });

/** The time-sensitive alert with the Coming / Decline buttons (notification category `assistance_call`). */
const urgent = (call: AssistanceCall, extraData: Record<string, unknown> = {}): Omit<ExpoMessage, "to" | "title" | "body"> => ({
  data: { url: "movescore://referee/master", kind: "assistance", callId: call.id, ...extraData },
  sound: "default",
  channelId: "assistance",
  priority: "high",
  interruptionLevel: "time-sensitive",
  categoryId: "assistance_call",
  ttl: 600,
});

/** The masters' phones for these referees (all on duty when `onlyRefereeIds` is absent). */
function phonesOf(duty: Duty, onlyRefereeIds?: string[]): string[] {
  const ids = onlyRefereeIds ?? duty.refereeIds;
  return ids.flatMap((id) => duty.byReferee[id] ?? []);
}

/**
 * Sends the call's alert to the master referees on duty (only `onlyRefereeIds` when
 * given: a reminder skips those who declined). Returns how many phones it went to.
 */
export async function alertMasters(call: AssistanceCall, onlyRefereeIds?: string[], duty?: Duty): Promise<number> {
  const d = duty ?? (await dutyFor(call));
  return pushTo(phonesOf(d, onlyRefereeIds), titled("pushTitle", "pushBody", { name: call.requested_by_name, court: call.court_name }), urgent(call));
}

/** A step the system took on a call (reminder, "is going", escalation): an audit row with who it went to. */
async function auditStep(call: AssistanceCall, action: string, value: Record<string, unknown>): Promise<void> {
  await db()
    .from("audit_logs")
    .insert({ organization_id: call.organization_id, tournament_id: call.tournament_id, actor_role: "system", action, entity_type: "assistance_call", entity_id: call.id, new_value: { court: call.court_name, ...value } });
}

async function addAlerted(callId: string, n: number): Promise<void> {
  if (!n) return;
  const { data } = await db().from("assistance_calls").select("alerted").eq("id", callId).maybeSingle();
  const now = (data as { alerted: number } | null)?.alerted ?? 0;
  await db().from("assistance_calls").update({ alerted: now + n }).eq("id", callId);
}

/* ---------------- the timed steps ---------------- */

/** The organiser's owners and admins: a push to their phones (signed in to the app) and a staff_alert email. Once per call (claimed by the caller). */
async function escalate(call: AssistanceCall, reason: "unanswered" | "all_declined", nowMs: number): Promise<void> {
  try {
    const minutes = Math.max(1, Math.round((nowMs - Date.parse(call.requested_at)) / 60_000));
    const vars = { name: call.requested_by_name, court: call.court_name, minutes };
    const { data } = await db().from("organization_members").select("id, auth_user_id, invited_email").eq("organization_id", call.organization_id).eq("status", "active").in("role", ["owner", "admin"]).limit(20);
    const members = (data ?? []) as { id: string; auth_user_id: string | null; invited_email: string | null }[];
    const userIds = [...new Set(members.map((m) => m.auth_user_id).filter((x): x is string => Boolean(x)))];
    let phones = 0;
    if (userIds.length) {
      const { data: devices } = await db().from("push_devices").select("expo_push_token, locale, app_version").in("user_id", userIds).is("disabled_at", null).not("expo_push_token", "is", null).limit(100);
      phones = await sendTo((devices ?? []) as Device[], titled("escalationTitle", "escalationBody", vars), {
        data: { kind: "assistance_escalated", callId: call.id },
        sound: "default",
        channelId: "assistance",
        priority: "high",
        interruptionLevel: "time-sensitive",
        ttl: 600,
      });
    }
    const { sendTransactional } = await import("../messaging/queue");
    const { siteUrl } = await import("../messaging/links");
    let emails = 0;
    const seen = new Set<string>();
    for (const m of members) {
      const to = m.invited_email?.trim().toLowerCase();
      if (!to || seen.has(to)) continue;
      seen.add(to);
      await sendTransactional({
        to,
        channel: "email",
        template: "staff_alert",
        vars: { title: callWord("en", "escalationTitle"), message: callWord("en", "escalationBody", vars), cta_label: "Open the calls", link: `${siteUrl()}/admin/org/referees/calls` },
        idempotencyKey: `assistance-escalated:${call.id}:${m.id}`,
        recipient: { kind: "adhoc", name: null },
      });
      emails++;
    }
    await auditStep(call, "ASSISTANCE_ESCALATED", { reason, phones, emails });
  } catch (err) {
    console.error("[assistance] escalation not sent:", err instanceof Error ? err.message : err);
  }
}

/**
 * Every timed step of an open call that nobody has taken, idempotent (safe from any number
 * of polls at once): the due reminder (claimed per 30-second window with a compare-and-set
 * on `reminders_sent`, then pushed to the masters on duty who have not declined) and the
 * escalation at ESCALATE_SECONDS (claimed by setting `escalated_at` where it is null).
 * Returns the call as it is now.
 */
export async function tickCall(call: AssistanceCall, nowMs = Date.now()): Promise<AssistanceCall> {
  if (call.status !== "open") return call;
  let cur = call;
  const nowIso = new Date(nowMs).toISOString();
  const due = reminderDue(cur, nowMs);
  if (due !== null) {
    const { data: claimed } = await db()
      .from("assistance_calls")
      .update({ reminders_sent: due, last_alert_at: nowIso })
      .eq("id", cur.id)
      .eq("status", "open")
      .eq("reminders_sent", cur.reminders_sent)
      .select(CALL_COLS)
      .maybeSingle();
    if (claimed) {
      cur = claimed as AssistanceCall;
      const [duty, responses] = await Promise.all([dutyFor(cur, nowMs), responsesFor([cur.id])]);
      const to = reminderRecipients(duty.refereeIds, responses.get(cur.id) ?? []);
      const phones = await pushTo(phonesOf(duty, to), titled("reminderTitle", "reminderBody", { court: cur.court_name }), urgent(cur, { reminder: due }));
      await addAlerted(cur.id, phones);
      await auditStep(cur, "ASSISTANCE_REMINDED", { window: due, to, phones });
      cur = { ...cur, alerted: cur.alerted + phones };
    } else {
      // Someone else claimed this window (or the call changed): read it again.
      const { data } = await db().from("assistance_calls").select(CALL_COLS).eq("id", cur.id).maybeSingle();
      if (data) cur = data as AssistanceCall;
    }
  }
  if (escalationDue(cur, nowMs)) cur = await claimEscalation(cur, "unanswered", nowMs);
  return cur;
}

async function claimEscalation(call: AssistanceCall, reason: "unanswered" | "all_declined", nowMs: number): Promise<AssistanceCall> {
  const { data: claimed } = await db()
    .from("assistance_calls")
    .update({ escalated_at: new Date(nowMs).toISOString() })
    .eq("id", call.id)
    .eq("status", "open")
    .is("escalated_at", null)
    .select(CALL_COLS)
    .maybeSingle();
  if (!claimed) return call;
  await escalate(claimed as AssistanceCall, reason, nowMs);
  return claimed as AssistanceCall;
}

/** The scheduled drain's backstop for phones that stopped polling: the timed steps of every open call (oldest first, at most 50). */
export async function tickOpenCalls(nowMs = Date.now()): Promise<{ checked: number }> {
  const { data } = await db()
    .from("assistance_calls")
    .select(CALL_COLS)
    .eq("status", "open")
    .lte("requested_at", new Date(nowMs - 25_000).toISOString())
    .order("requested_at")
    .limit(50);
  const calls = (data ?? []) as AssistanceCall[];
  for (const c of calls) await tickCall(c, nowMs);
  return { checked: calls.length };
}

/* ---------------- the chair umpire's call ---------------- */

/**
 * Whether "Call master referee" (Admin → Scoring features, `features.callMaster`) is on
 * for a chair umpire (audit L1): the match's own tournament when the call names one,
 * otherwise any of the court's events. Enforced here, not only by the consoles hiding the
 * button.
 */
export async function callMasterEnabled(staff: Pick<StaffPrincipal, "scopeCourt">, tournamentId?: string | null): Promise<boolean> {
  const ids = tournamentId ? [tournamentId] : (staff.scopeCourt?.tournamentIds ?? []);
  if (!ids.length) return false;
  const { data } = await db().from("tournaments").select("id, sport, match_day_rules").in("id", ids.slice(0, 80));
  return ((data ?? []) as { sport: string | null; match_day_rules: unknown }[]).some((t) => matchDayRules(t.match_day_rules, t).features.callMaster);
}

/**
 * "Call for assistance" from a chair umpire (court code + PIN). One open call per
 * physical court: a tap while one is open joins it (a tap within TAP_DEDUPE_SECONDS
 * is the same tap; later taps re-alert the masters who have not answered, at most every
 * REALERT_SECONDS; a tap after a master answered Coming re-rings the call for every master
 * who has not declined). New calls per court: at most CALLS_PER_COURT per window.
 */
export async function requestAssistance(staff: StaffPrincipal, opts: { matchId?: string | null; tournamentId?: string | null } = {}, nowMs = Date.now()): Promise<CallOutcome> {
  if (!isCourtReferee(staff)) return refusal(403, "court_referee_only", "Only a chair umpire signed in with their PIN can call for assistance.");
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
    // "Call again" after a master answered Coming (owner, 22 Oct 2026): the court still needs
    // someone NOW, so the call rings again for every master on duty who has not declined,
    // the one coming included (their Coming is cleared; they answer again). Audited.
    const coming = ((await responsesFor([open.id])).get(open.id) ?? []).filter((r) => r.answer === "coming");
    if (open.status === "acknowledged" || coming.length) {
      const { data: reopened } = await db()
        .from("assistance_calls")
        .update({ status: "open", acknowledged_at: null, acknowledged_by: null, acknowledged_by_name: null, taps: open.taps + 1, last_tap_at: nowIso })
        .eq("id", open.id)
        .eq("taps", open.taps)
        .select(CALL_COLS)
        .maybeSingle();
      if (!reopened) return { ok: true, call: open, deduped: true };
      await db().from("assistance_responses").delete().eq("call_id", open.id).eq("answer", "coming");
      const call = reopened as AssistanceCall;
      await auditStep(call, "ASSISTANCE_RECALLED", { was_coming: coming.map((r) => r.name), by: referee.name });
      const [duty, responses] = await Promise.all([dutyFor(call, nowMs), responsesFor([call.id])]);
      const n = await alertMasters(call, reminderRecipients(duty.refereeIds, responses.get(call.id) ?? []), duty);
      if (n) await db().from("assistance_calls").update({ alerted: call.alerted + n, last_alert_at: nowIso }).eq("id", call.id);
      return { ok: true, call: { ...call, alerted: call.alerted + n }, deduped: true };
    }
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
      const [duty, responses] = await Promise.all([dutyFor(updated, nowMs), responsesFor([updated.id])]);
      const n = await alertMasters(updated, reminderRecipients(duty.refereeIds, responses.get(updated.id) ?? []), duty);
      if (n) await db().from("assistance_calls").update({ alerted: updated.alerted + n, last_alert_at: nowIso }).eq("id", updated.id);
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
      last_alert_at: nowIso,
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

async function loadCall(staff: StaffPrincipal, callId: string): Promise<AssistanceCall | null> {
  if (!isUuid(callId)) return null;
  const { data } = await db().from("assistance_calls").select(CALL_COLS).eq("id", callId).eq("organization_id", staff.orgId).maybeSingle();
  return (data as AssistanceCall | null) ?? null;
}

/**
 * A master referee's answer (0042). Coming: the first one takes the call (compare-and-set
 * open → acknowledged), the other masters on duty are told who is going, the reminders
 * stop; a Coming after someone else took it is 409 `already_taken` with their name.
 * Decline: recorded (it replaces an earlier answer), the call stays open, that master's
 * reminders stop; when every master on duty declined, the organiser is alerted at once.
 */
export async function respondToCall(staff: StaffPrincipal, callId: string, answer: CallAnswer, nowMs = Date.now()): Promise<CallOutcome> {
  const call = await loadCall(staff, callId);
  // Not theirs: the same answer as a call that does not exist.
  if (!call || !isMasterReferee(staff) || !masterCovers(staff, call)) return refusal(404, "not_found", "Not found");
  const referee = staff.referee!;
  if (!isOpenCall(call.status)) return refusal(409, "closed", "This call is already closed.");
  const nowIso = new Date(nowMs).toISOString();
  const taken = (c: AssistanceCall): CallOutcome => ({
    ok: false,
    status: 409,
    code: "already_taken",
    error: callWord("en", "alreadyTaken", { name: c.acknowledged_by_name ?? "A master referee" }),
    takenBy: c.acknowledged_by_name,
    call: c,
  });
  const record = (a: CallAnswer) =>
    db()
      .from("assistance_responses")
      .upsert({ call_id: call.id, referee_id: referee.id, organization_id: call.organization_id, referee_name: referee.name, answer: a, answered_at: nowIso }, { onConflict: "call_id,referee_id" });

  if (answer === "coming") {
    if (call.status !== "open") return taken(call);
    // Compare-and-set: two masters tapping Coming at once, one wins.
    const { data: changed } = await db()
      .from("assistance_calls")
      .update({ status: "acknowledged", acknowledged_at: nowIso, acknowledged_by: referee.id, acknowledged_by_name: referee.name })
      .eq("id", call.id)
      .eq("status", "open")
      .select(CALL_COLS)
      .maybeSingle();
    if (!changed) {
      const now = (await loadCall(staff, call.id)) ?? call;
      return now.status === "acknowledged" ? taken(now) : refusal(409, "changed", "Someone else answered this call first.");
    }
    const won = changed as AssistanceCall;
    await record("coming");
    // Everyone else on duty: "Master referee Sara is going to the emergency call at Court 2" (not time-sensitive).
    const duty = await dutyFor(won, nowMs);
    const others = duty.refereeIds.filter((id) => id !== referee.id);
    const phones = await pushTo(phonesOf(duty, others), titled("goingTitle", "goingBody", { name: referee.name, court: won.court_name }), {
      data: { url: "movescore://referee/master", kind: "assistance_going", callId: won.id },
      sound: "default",
      channelId: "matches",
      ttl: 600,
    });
    await auditStep(won, "ASSISTANCE_GOING_SENT", { going: referee.name, to: others, phones });
    return { ok: true, call: won };
  }

  if (call.status === "acknowledged" && call.acknowledged_by === referee.id) return refusal(409, "not_allowed", "You are on the way: mark it resolved once it is sorted.");
  await record("declined");
  if (call.status === "open") {
    const [duty, responses] = await Promise.all([dutyFor(call, nowMs), responsesFor([call.id])]);
    if (escalationDue(call, nowMs, duty.refereeIds, responses.get(call.id) ?? [])) {
      const reason = nowMs - Date.parse(call.requested_at) >= ESCALATE_SECONDS * 1000 ? "unanswered" : "all_declined";
      return { ok: true, call: await claimEscalation(call, reason, nowMs) };
    }
  }
  return { ok: true, call };
}

/** "Coming" (as acknowledge, Move Score 1.0.1's "On my way"), "Resolved" (master referees, the organiser) and "Cancel" (the chair umpire who called). */
export async function actOnCall(staff: StaffPrincipal, callId: string, action: CallAction, nowMs = Date.now()): Promise<CallOutcome> {
  const call = await loadCall(staff, callId);
  if (!call) return refusal(404, "not_found", "Not found");
  let who: "master" | "court" | "staff" | null = null;
  if (isMasterReferee(staff) && masterCovers(staff, call)) who = "master";
  else if (isCourtReferee(staff) && call.code_id === staff.codeId) who = "court";
  else if (isOrganiser(staff)) who = "staff";
  // Not theirs: the same answer as a call that does not exist.
  if (!who) return refusal(404, "not_found", "Not found");
  // 1.0.1's "On my way" is the new Coming (the other masters are told, reminders stop).
  if (action === "acknowledge" && who === "master") return respondToCall(staff, callId, "coming", nowMs);
  const next = nextCallStatus(call.status, action, who);
  if (!next) return refusal(409, isOpenCall(call.status) ? "not_allowed" : "closed", isOpenCall(call.status) ? "Not allowed" : "This call is already closed.");
  const nowIso = new Date(nowMs).toISOString();
  const name = staff.referee?.name ?? (staff.kind === "member" ? "The organiser" : "Tournament desk");
  const patch: Record<string, unknown> = { status: next };
  if (next === "resolved" || next === "cancelled") Object.assign(patch, { resolved_at: nowIso, resolved_by: staff.referee?.id ?? null, resolved_by_name: name });
  const { data: changed } = await db().from("assistance_calls").update(patch).eq("id", call.id).eq("status", call.status).select(CALL_COLS).maybeSingle();
  if (!changed) return refusal(409, "changed", "Someone else answered this call first.");
  return { ok: true, call: changed as AssistanceCall };
}

/** The open calls a master referee covers (oldest first, their timed steps run first), and the ones closed in the last half hour. */
export async function callsForMaster(staff: StaffPrincipal, nowMs = Date.now()): Promise<{ open: AssistanceCall[]; recent: AssistanceCall[] }> {
  const ids = staff.scopeTournamentIds ?? [];
  if (!ids.length) return { open: [], recent: [] };
  const since = new Date(nowMs - 30 * 60_000).toISOString();
  const [{ data: open }, { data: recent }] = await Promise.all([
    db().from("assistance_calls").select(CALL_COLS).eq("organization_id", staff.orgId).in("tournament_id", ids).in("status", ["open", "acknowledged"]).order("requested_at").limit(50),
    db().from("assistance_calls").select(CALL_COLS).eq("organization_id", staff.orgId).in("tournament_id", ids).in("status", ["resolved", "cancelled"]).gte("resolved_at", since).order("resolved_at", { ascending: false }).limit(20),
  ]);
  const ticked: AssistanceCall[] = [];
  for (const c of (open ?? []) as AssistanceCall[]) ticked.push(await tickCall(c, nowMs));
  return { open: ticked, recent: (recent ?? []) as AssistanceCall[] };
}

/** The chair umpire's own court: its open call (its timed steps run first), or the last one closed in the past two minutes. */
export async function callForCourt(staff: StaffPrincipal, nowMs = Date.now()): Promise<AssistanceCall | null> {
  if (!isCourtReferee(staff)) return null;
  const court = staff.scopeCourt!;
  const scopeKey = court.eventGroupId ?? staff.scopeTournamentId ?? court.tournamentIds[0] ?? null;
  if (!scopeKey) return null;
  const open = await openCallAt(staff.orgId, scopeKey, courtKey(court.name));
  if (open) return tickCall(open, nowMs);
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

/** Every call of the organisation, newest first (Admin → Referees → Calls for assistance), with the declines. */
export async function callLog(orgId: string, limit = 300): Promise<(AssistanceCall & { declined: string[] })[]> {
  const { data } = await db().from("assistance_calls").select(CALL_COLS).eq("organization_id", orgId).order("requested_at", { ascending: false }).limit(limit);
  const calls = (data ?? []) as AssistanceCall[];
  const responses = await responsesFor(calls.slice(0, 100).map((c) => c.id));
  return calls.map((c) => ({ ...c, declined: (responses.get(c.id) ?? []).filter((r) => r.answer === "declined").map((r) => r.name) }));
}
