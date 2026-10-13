/**
 * The match-day engine on the server (plan Phase 3): telling the next match on a
 * court that it is nearly on ("match soon"), calling a match to its court, the
 * players' presence, the reminder, extensions and the no-show answer.
 *
 * What a call looks like at any instant is the pure src/lib/matchday/call.ts; this
 * module stores it (match_calls), sends the alerts (notification_events, through
 * src/lib/notify/hooks.ts) and moves lock-screen cards (notifyLiveActivityPhase).
 *
 *   onScoreProgress  after every scoring batch (src/lib/scoring/append.ts, after the
 *                    response): a side came one game from winning → the players of
 *                    the next match on that court hear "you're next", once per match
 *                    (matches.match_soon_at), never for a match with a side still to
 *                    be decided, and not for players busy on another court.
 *   callToCourt      status `ready`; idempotent; 409 while the court is busy unless
 *                    forced. Alerts the players and schedules the reminder at the
 *                    deadline − reminderMinutes as a future outbox row the scheduled
 *                    drain sends (supabase/ops/notification_cron.sql).
 *   markPresent / extendCall / answerNoShow / cancelCall
 *   closeCall        on MATCH_STARTED or a result (the events path).
 *
 * Every write is a plain filtered update (the stand-in has no RPC): a step that
 * lost a race to another device finds no row to change and reports "changed".
 * Nothing here selects or sends a player's private columns: alert payloads carry
 * names and player row ids only.
 *
 * Server-only. Callers check the staff principal (staffRoute) or the player
 * (player_claims) first.
 */
import { db } from "../supabase";
import { audit } from "../audit";
import { getMatch, getSnapshot, getTournament, tierForMatch } from "../data";
import { scoringConfigForMatch } from "../scoring/rules";
import type { ScoreState, TeamKey } from "../scoring/engine";
import type { Match, MatchRules, Tournament } from "../types";
import { isMatchDay } from "./eventDay";
import { matchDayRules, type MatchDayRules } from "./rules";
import { sportOf } from "../sports/registry";
import { nearEndCrossed } from "./nearEnd";
import { nextOnCourt, type QueueMatch } from "./courtQueue";
import { callDeadline, callReminderAt, callView, extendCall as extendPure, type CallAction, type CallView, type CourtCall } from "./call";

const MINUTE = 60_000;
/** A reminder this close to the call itself is no reminder: the call says the same. */
const MIN_REMINDER_GAP_MS = 30_000;

export type CallStatus = "called" | "started" | "walkover" | "cancelled";

interface CallRow {
  match_id: string;
  tournament_id: string;
  court_id: string | null;
  called_at: string;
  deadline_at: string;
  extensions: number;
  a_present_at: string | null;
  b_present_at: string | null;
  status: CallStatus;
  answer: CallAnswer | null;
  called_by_role: string | null;
  updated_at: string;
}

const CALL_COLUMNS = "match_id, tournament_id, court_id, called_at, deadline_at, extensions, a_present_at, b_present_at, status, answer, called_by_role, updated_at";

export interface CallAnswer {
  action: "wait" | "walkover_to_a" | "walkover_to_b" | "both_no_show" | "cancel";
  at: string;
  by: string;
}

/** What the referee's console, the web console and the call route read. No device ids, no player data. */
export interface CallState {
  matchId: string;
  courtId: string | null;
  status: CallStatus;
  calledAt: string;
  deadlineAt: string;
  extensions: number;
  presentA: boolean;
  presentB: boolean;
  answer: CallAnswer | null;
  view: CallView;
}

/** The parts of the rules a console shows next to a call. */
export interface CallRules {
  on: boolean;
  autoOnRefereeOpen: boolean;
  minutes: number;
  reminderMinutes: number;
  noShow: boolean;
  extensionMinutes: number;
  maxExtensions: number;
  bothAbsentPromptOnly: boolean;
  imAtCourt: boolean;
  qrCheckInPresent: boolean;
}

export type Outcome<T> = { ok: true; status: number; value: T } | { ok: false; status: number; error: string; code: string };

const refuse = <T>(status: number, code: string, error: string): Outcome<T> => ({ ok: false, status, code, error });

function asCourtCall(row: CallRow): CourtCall {
  return {
    calledAt: row.called_at,
    extensions: row.extensions,
    presentA: Boolean(row.a_present_at),
    presentB: Boolean(row.b_present_at),
    closedAt: row.status === "called" ? null : row.updated_at,
  };
}

function toState(row: CallRow, rules: MatchDayRules, nowMs: number): CallState {
  const call = asCourtCall(row);
  return {
    matchId: row.match_id,
    courtId: row.court_id,
    status: row.status,
    calledAt: new Date(Date.parse(row.called_at)).toISOString(),
    deadlineAt: new Date(callDeadline(call, rules)).toISOString(),
    extensions: row.extensions,
    presentA: call.presentA,
    presentB: call.presentB,
    answer: row.answer ?? null,
    view: callView(call, rules, nowMs),
  };
}

export function callRules(r: MatchDayRules): CallRules {
  return {
    on: r.courtCall.on,
    autoOnRefereeOpen: r.courtCall.autoOnRefereeOpen,
    minutes: r.courtCall.minutes,
    reminderMinutes: r.courtCall.reminderMinutes,
    noShow: r.noShow.on,
    extensionMinutes: r.noShow.extensionMinutes,
    maxExtensions: r.noShow.maxExtensions,
    bothAbsentPromptOnly: r.noShow.bothAbsentPromptOnly,
    imAtCourt: r.extras.imAtCourt,
    qrCheckInPresent: r.extras.qrCheckInPresent,
  };
}

async function readCall(matchId: string): Promise<CallRow | null> {
  const { data, error } = await db().from("match_calls").select(CALL_COLUMNS).eq("match_id", matchId).maybeSingle();
  if (error) return null;
  return (data as CallRow | null) ?? null;
}

interface Day {
  match: Match;
  tournament: Tournament;
  rules: MatchDayRules;
}

async function dayOf(matchId: string): Promise<Day | null> {
  const match = await getMatch(matchId);
  if (!match) return null;
  const tournament = await getTournament(match.tournament_id);
  if (!tournament) return null;
  return { match, tournament, rules: matchDayRules(tournament.match_day_rules, tournament) };
}

/** Alerts stay quiet outside the event's days when the organiser asked for that. */
function quiet(t: Tournament, rules: MatchDayRules, nowMs: number): boolean {
  return rules.extras.quietOutsideEventDays && !isMatchDay(t, nowMs, true);
}

/** Both sides known (and, for a rubber, both line-ups nominated). */
function sidesKnown(m: Pick<Match, "team_a_id" | "team_b_id" | "tie_id" | "team_a_player_ids" | "team_b_player_ids">): boolean {
  if (!m.team_a_id || !m.team_b_id) return false;
  if (m.tie_id && (!m.team_a_player_ids?.length || !m.team_b_player_ids?.length)) return false;
  return true;
}

/* ---------------- "match soon" ---------------- */

/** The match's own scoring rules, exactly as the consoles resolve them. */
async function scoringRulesFor(t: Tournament, match: Match): Promise<MatchRules> {
  const tier = await tierForMatch(match);
  let doubles = match.rubber_type ? match.rubber_type === "D" : false;
  if (!match.rubber_type) {
    const teams = [match.team_a_id, match.team_b_id].filter(Boolean) as string[];
    const { data } = teams.length ? await db().from("players").select("team_id").in("team_id", teams) : { data: [] };
    const count = new Map<string, number>();
    for (const p of (data ?? []) as { team_id: string }[]) count.set(p.team_id, (count.get(p.team_id) ?? 0) + 1);
    doubles = [...count.values()].some((n) => n >= 2);
  }
  return scoringConfigForMatch(t, match, tier, { doubles });
}

type CourtRow = QueueMatch & Pick<Match, "team_a_id" | "team_b_id" | "team_a_player_ids" | "team_b_player_ids" | "tie_id" | "round_name">;
const COURT_ROW_COLUMNS = "id, court_id, status, scheduled_time, match_order, team_a_id, team_b_id, team_a_player_ids, team_b_player_ids, tie_id, round_name";

export type SoonOutcome =
  | { sent: true; nextMatchId: string; playerIds: string[] }
  | { sent: false; reason: "no_court" | "off" | "already" | "not_crossed" | "quiet" | "no_next" | "tbd" | "busy" | "error" };

/**
 * After a scoring batch: when it brought a side one game from winning (under the
 * match's own rules; a super tie-break is one game), the players of the next match
 * on the same court (inside this event) are told to get ready. Once per match:
 * `matches.match_soon_at` is claimed with a filtered update before anything is
 * sent. Skipped — and not claimed, so a later crossing may still send it — when
 * the next match has a side to be decided, or every one of its players is busy on
 * another court (skipSoonIfBusy). Starred fans of the next match hear it only when
 * the organiser turned that on.
 */
export async function onScoreProgress(input: { match: Match; before: unknown; after: unknown; nowMs?: number }): Promise<SoonOutcome> {
  const nowMs = input.nowMs ?? Date.now();
  const match = input.match;
  if (!match.court_id) return { sent: false, reason: "no_court" };
  if (match.match_soon_at) return { sent: false, reason: "already" };
  const t = await getTournament(match.tournament_id);
  if (!t) return { sent: false, reason: "error" };
  const rules = matchDayRules(t.match_day_rules, t);
  if (!rules.matchSoon.on) return { sent: false, reason: "off" };
  const scoring = await scoringRulesFor(t, match);
  if (!nearEndCrossed(scoring, input.before as ScoreState | null, input.after as ScoreState | null)) return { sent: false, reason: "not_crossed" };
  if (quiet(t, rules, nowMs)) return { sent: false, reason: "quiet" };

  const { data: rows } = await db()
    .from("matches")
    .select(COURT_ROW_COLUMNS)
    .eq("tournament_id", match.tournament_id)
    .in("status", ["scheduled", "ready", "live", "paused"]);
  const all = (rows ?? []) as unknown as CourtRow[];
  const next = nextOnCourt(all.filter((m) => m.id !== match.id), match.court_id);
  if (!next) return { sent: false, reason: "no_next" };
  if (!sidesKnown(next)) return { sent: false, reason: "tbd" };

  const { alertContext, alertSideLabel, alertSidePlayerIds, enqueueAlert, notifyLiveActivityPhase } = await import("../notify/hooks");
  const ctx = await alertContext(match.tournament_id);
  let players = [...alertSidePlayerIds(ctx, next, "A"), ...alertSidePlayerIds(ctx, next, "B")];
  if (rules.extras.skipSoonIfBusy) {
    const busy = new Set<string>();
    for (const m of all) {
      if (m.id === match.id || m.court_id === match.court_id || (m.status !== "live" && m.status !== "paused")) continue;
      for (const id of [...alertSidePlayerIds(ctx, m, "A"), ...alertSidePlayerIds(ctx, m, "B")]) busy.add(id);
    }
    players = players.filter((id) => !busy.has(id));
  }
  const starred = rules.matchSoon.starredFans;
  if (!players.length && !starred) return { sent: false, reason: "busy" };

  // Once per match, whichever request gets here first.
  const { data: claimed } = await db()
    .from("matches")
    .update({ match_soon_at: new Date(nowMs).toISOString() })
    .eq("id", match.id)
    .is("match_soon_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) return { sent: false, reason: "already" };

  if (rules.alerts.on) {
    const { composeMatchSoon } = await import("../notify/compose");
    await enqueueAlert({
      kind: "match_soon",
      tournamentId: match.tournament_id,
      matchId: next.id,
      tieId: next.tie_id ?? null,
      dedupeKey: `match:${match.id}:soon`,
      payload: composeMatchSoon({
        matchId: next.id,
        a: alertSideLabel(ctx, next, "A"),
        b: alertSideLabel(ctx, next, "B"),
        court: ctx.courts.get(match.court_id) ?? "the court",
        label: next.round_name ?? ctx.tournament.name,
        playerIds: players,
        starredFans: starred,
      }),
    });
  }
  const until = next.scheduled_time ? Date.parse(next.scheduled_time) : NaN;
  await notifyLiveActivityPhase(next.id, { phase: "soon", until: Number.isFinite(until) ? until : null });
  return { sent: true, nextMatchId: next.id, playerIds: players };
}

/* ---------------- alerts for a call ---------------- */

/** How long a match's players hear "called to court" only once, however often it is called. */
export const CALL_ALERT_DEDUPE_MS = 10 * MINUTE;

/** Whether this match's players were told "called to court" in the last 10 minutes. */
async function calledRecently(matchId: string, nowMs: number): Promise<boolean> {
  const since = new Date(nowMs - CALL_ALERT_DEDUPE_MS).toISOString();
  const { data } = await db()
    .from("notification_events")
    .select("id")
    .eq("match_id", matchId)
    .eq("kind", "called_to_court")
    .neq("status", "cancelled")
    .gte("created_at", since)
    .limit(1);
  return (data ?? []).length > 0;
}

async function callAlerts(day: Day, row: CallRow, opts: { announce: boolean; nowMs: number }) {
  const { match, tournament, rules } = day;
  if (!rules.alerts.on || quiet(tournament, rules, opts.nowMs)) return;
  const [{ alertContext, alertSideLabel, alertSidePlayerIds, enqueueAlert }, { composeCalledToCourt, composeCallReminder }] = await Promise.all([
    import("../notify/hooks"),
    import("../notify/compose"),
  ]);
  const ctx = await alertContext(match.tournament_id);
  const call = asCourtCall(row);
  const deadline = callDeadline(call, rules);
  const base = {
    matchId: match.id,
    a: alertSideLabel(ctx, match, "A"),
    b: alertSideLabel(ctx, match, "B"),
    court: (match.court_id && ctx.courts.get(match.court_id)) || "the court",
    label: match.round_name ?? ctx.tournament.name,
    timeZone: ctx.tournament.timezone,
    deadline: new Date(deadline).toISOString(),
  };
  if (opts.announce && !(await calledRecently(match.id, opts.nowMs))) {
    await enqueueAlert({
      kind: "called_to_court",
      tournamentId: match.tournament_id,
      matchId: match.id,
      tieId: match.tie_id ?? null,
      dedupeKey: `match:${match.id}:call:${Date.parse(row.called_at)}`,
      payload: composeCalledToCourt({
        ...base,
        playerIds: [...alertSidePlayerIds(ctx, match, "A"), ...alertSidePlayerIds(ctx, match, "B")],
        minutes: Math.round((deadline - Date.parse(row.called_at)) / MINUTE),
      }),
    });
  }
  const reminderAt = callReminderAt(call, rules);
  if (reminderAt - Date.parse(row.called_at) < MIN_REMINDER_GAP_MS || reminderAt >= deadline) return;
  const absent = [...(call.presentA ? [] : alertSidePlayerIds(ctx, match, "A")), ...(call.presentB ? [] : alertSidePlayerIds(ctx, match, "B"))];
  if (!absent.length) return;
  // Sent by the scheduled drain when due; a new deadline (an extension) gets its own.
  await enqueueAlert({
    kind: "call_reminder",
    tournamentId: match.tournament_id,
    matchId: match.id,
    tieId: match.tie_id ?? null,
    dedupeKey: `match:${match.id}:reminder:${deadline}`,
    fireAt: new Date(reminderAt).toISOString(),
    payload: composeCallReminder({ ...base, playerIds: absent, minutesLeft: rules.courtCall.reminderMinutes }),
  });
}

/** Withdraws a call's reminders that have not gone out yet. */
async function cancelReminders(matchId: string) {
  await db().from("notification_events").update({ status: "cancelled" }).eq("match_id", matchId).eq("kind", "call_reminder").eq("status", "pending");
}

/** A pending reminder goes only to the players still missing; none missing, none sent. */
async function trimReminders(day: Day, row: CallRow) {
  const call = asCourtCall(row);
  if (call.presentA && call.presentB) return cancelReminders(row.match_id);
  const { data } = await db().from("notification_events").select("id, payload").eq("match_id", row.match_id).eq("kind", "call_reminder").eq("status", "pending");
  const pending = (data ?? []) as { id: string; payload: import("../notify/compose").AlertPayload }[];
  if (!pending.length) return;
  const { alertContext, alertSidePlayerIds } = await import("../notify/hooks");
  const ctx = await alertContext(day.match.tournament_id);
  const absent = [...(call.presentA ? [] : alertSidePlayerIds(ctx, day.match, "A")), ...(call.presentB ? [] : alertSidePlayerIds(ctx, day.match, "B"))];
  for (const ev of pending) {
    if (!ev.payload.self) continue;
    await db()
      .from("notification_events")
      .update({ payload: { ...ev.payload, self: { ...ev.payload.self, playerIds: absent } } })
      .eq("id", ev.id)
      .eq("status", "pending");
  }
}

/* ---------------- the call ---------------- */

/** The call of a match, as the consoles read it (null when it was never called). */
export async function getCall(matchId: string, nowMs = Date.now()): Promise<{ call: CallState | null; rules: CallRules } | null> {
  const day = await dayOf(matchId);
  if (!day) return null;
  const row = await readCall(matchId);
  return { call: row ? toState(row, day.rules, nowMs) : null, rules: callRules(day.rules) };
}

/**
 * Calls a match to its court: the match becomes `ready`, its players have
 * `courtCall.minutes` to get there. Calling a match that is already called gives
 * the same call back (200, nothing sent again). Refused (409) while another match
 * is live on the court, unless `force`.
 */
export async function callToCourt(
  matchId: string,
  opts: { role: string; force?: boolean; auto?: boolean; nowMs?: number },
): Promise<Outcome<{ call: CallState; created: boolean }>> {
  const nowMs = opts.nowMs ?? Date.now();
  const day = await dayOf(matchId);
  if (!day) return refuse(404, "not_found", "Not found");
  const { match, rules } = day;
  if (!rules.courtCall.on) return refuse(409, "call_off", "Court calls are off for this tournament (Match day tab).");
  const existing = await readCall(matchId);
  if (existing?.status === "called") return { ok: true, status: 200, value: { call: toState(existing, rules, nowMs), created: false } };
  if (match.status !== "scheduled" && match.status !== "ready") return refuse(409, "not_waiting", "This match has already started or finished.");
  if (!sidesKnown(match)) return refuse(409, "tbd", "Both sides (and a rubber's line-ups) must be known before the match is called.");
  if (!match.court_id) return refuse(409, "no_court", "Give the match a court first.");
  if (!opts.force) {
    const { data: onCourt } = await db()
      .from("matches")
      .select("id")
      .eq("tournament_id", match.tournament_id)
      .eq("court_id", match.court_id)
      .in("status", ["live", "paused"])
      .neq("id", match.id)
      .limit(1);
    if ((onCourt ?? []).length) return refuse(409, "court_busy", "Another match is still on this court. Call it anyway only if that match is about to end.");
  }

  const calledAt = new Date(nowMs).toISOString();
  const deadline = new Date(callDeadline({ calledAt: nowMs, extensions: 0, presentA: false, presentB: false }, rules)).toISOString();
  const fresh = {
    tournament_id: match.tournament_id,
    court_id: match.court_id,
    called_at: calledAt,
    deadline_at: deadline,
    extensions: 0,
    a_present_at: null,
    b_present_at: null,
    status: "called" as const,
    answer: null,
    called_by_role: opts.auto ? `${opts.role}:auto` : opts.role,
    updated_at: calledAt,
  };
  let row: CallRow | null = null;
  if (existing) {
    // Called again after a withdrawn call: only if nobody re-called it meanwhile.
    const { data } = await db().from("match_calls").update(fresh).eq("match_id", matchId).eq("status", existing.status).select(CALL_COLUMNS).maybeSingle();
    row = (data as CallRow | null) ?? null;
  } else {
    const { data, error } = await db().from("match_calls").insert({ match_id: matchId, ...fresh }).select(CALL_COLUMNS).maybeSingle();
    if (error && !/duplicate|unique|23505|conflict/i.test(`${error.code ?? ""} ${error.message}`)) return refuse(500, "failed", "The call could not be saved. Try again.");
    row = (data as CallRow | null) ?? null;
  }
  if (!row) {
    // Another device called it at the same moment: theirs is the call.
    const now = await readCall(matchId);
    if (now?.status === "called") return { ok: true, status: 200, value: { call: toState(now, rules, nowMs), created: false } };
    return refuse(409, "changed", "The call changed on another device. Reload.");
  }
  await db().from("matches").update({ status: "ready", updated_at: calledAt }).eq("id", matchId).eq("status", "scheduled");
  await audit({
    tournament_id: match.tournament_id,
    actor_role: opts.role,
    action: "MATCH_CALLED",
    entity_type: "match",
    entity_id: matchId,
    new_value: { court_id: match.court_id, deadline_at: deadline, forced: Boolean(opts.force), auto: Boolean(opts.auto) },
  });
  await callAlerts(day, row, { announce: true, nowMs });
  if (!quiet(day.tournament, rules, nowMs)) {
    const { notifyLiveActivityPhase } = await import("../notify/hooks");
    await notifyLiveActivityPhase(matchId, { phase: "called", until: Date.parse(deadline), from: nowMs });
  }
  return { ok: true, status: 201, value: { call: toState(row, rules, nowMs), created: true } };
}

/**
 * The referee opened the match (the app's bootstrap, the web console): with
 * "auto on referee open" the match is called, on a match day, when it is waiting,
 * was never called, and its court is free. Never throws, never forces.
 */
export async function autoCallOnOpen(matchId: string, role: string, nowMs = Date.now()): Promise<boolean> {
  try {
    const day = await dayOf(matchId);
    if (!day) return false;
    const { match, tournament, rules } = day;
    if (!rules.courtCall.on || !rules.courtCall.autoOnRefereeOpen) return false;
    if (match.status !== "scheduled" || !sidesKnown(match) || !match.court_id) return false;
    if (!isMatchDay(tournament, nowMs, true)) return false;
    if (await readCall(matchId)) return false; // called before (or withdrawn by the organiser): not again on its own
    const r = await callToCourt(matchId, { role, auto: true, nowMs });
    return r.ok && r.value.created;
  } catch (err) {
    console.error("auto call failed", err);
    return false;
  }
}

async function openCall(matchId: string, nowMs: number): Promise<Outcome<{ day: Day; row: CallRow }>> {
  const day = await dayOf(matchId);
  if (!day) return refuse(404, "not_found", "Not found");
  const row = await readCall(matchId);
  if (!row || row.status !== "called") return refuse(409, "no_call", "This match is not called to court.");
  void nowMs;
  return { ok: true, status: 200, value: { day, row } };
}

export type PresentBy = "referee" | "player" | "qr";

/** One side is at the court. Idempotent; a pending reminder then goes only to the side still missing. */
export async function markPresent(matchId: string, side: TeamKey, opts: { by: PresentBy; role: string; nowMs?: number }): Promise<Outcome<{ call: CallState; changed: boolean }>> {
  const nowMs = opts.nowMs ?? Date.now();
  const open = await openCall(matchId, nowMs);
  if (!open.ok) return open;
  const { day, row } = open.value;
  const column = side === "A" ? "a_present_at" : "b_present_at";
  if (row[column]) return { ok: true, status: 200, value: { call: toState(row, day.rules, nowMs), changed: false } };
  const at = new Date(nowMs).toISOString();
  const { data } = await db()
    .from("match_calls")
    .update({ [column]: at, updated_at: at })
    .eq("match_id", matchId)
    .eq("status", "called")
    .is(column, null)
    .select(CALL_COLUMNS)
    .maybeSingle();
  const updated = (data as CallRow | null) ?? (await readCall(matchId));
  if (!updated) return refuse(409, "changed", "The call changed on another device. Reload.");
  if (data) {
    await audit({
      tournament_id: day.match.tournament_id,
      actor_role: opts.role,
      action: "CALL_PRESENT",
      entity_type: "match",
      entity_id: matchId,
      new_value: { side, by: opts.by },
    });
    await trimReminders(day, updated);
  }
  return { ok: true, status: 200, value: { call: toState(updated, day.rules, nowMs), changed: Boolean(data) } };
}

/** The referee's "+N min" at the no-show prompt. */
export async function extendCall(matchId: string, opts: { role: string; nowMs?: number }): Promise<Outcome<{ call: CallState }>> {
  const nowMs = opts.nowMs ?? Date.now();
  const open = await openCall(matchId, nowMs);
  if (!open.ok) return open;
  const { day, row } = open.value;
  const r = extendPure(asCourtCall(row), day.rules, nowMs);
  if (!r.ok) {
    const message: Record<typeof r.reason, string> = {
      closed: "This call is over.",
      no_show_off: "The no-show prompt is off for this tournament.",
      not_due: "The deadline has not passed yet.",
      max_extensions: "No more extensions: the maximum is used.",
      all_present: "Both sides are at the court.",
    };
    return refuse(409, r.reason, message[r.reason]);
  }
  const at = new Date(nowMs).toISOString();
  const { data } = await db()
    .from("match_calls")
    .update({ extensions: r.call.extensions, deadline_at: new Date(r.deadlineAt).toISOString(), updated_at: at })
    .eq("match_id", matchId)
    .eq("status", "called")
    .eq("extensions", row.extensions)
    .select(CALL_COLUMNS)
    .maybeSingle();
  const updated = data as CallRow | null;
  if (!updated) return refuse(409, "changed", "The call changed on another device. Reload.");
  await audit({
    tournament_id: day.match.tournament_id,
    actor_role: opts.role,
    action: "CALL_EXTENDED",
    entity_type: "match",
    entity_id: matchId,
    new_value: { extensions: updated.extensions, deadline_at: updated.deadline_at },
  });
  await cancelReminders(matchId);
  await callAlerts(day, updated, { announce: false, nowMs });
  if (!quiet(day.tournament, day.rules, nowMs)) {
    const { notifyLiveActivityPhase } = await import("../notify/hooks");
    await notifyLiveActivityPhase(matchId, { phase: "called", until: r.deadlineAt, from: Date.parse(updated.called_at) });
  }
  return { ok: true, status: 200, value: { call: toState(updated, day.rules, nowMs) } };
}

export type NoShowAnswer = "wait" | "walkover_to_a" | "walkover_to_b" | "both_no_show";

/**
 * The referee's answer to the no-show prompt (only at or after the deadline):
 *   wait            keep waiting (recorded; nothing else changes)
 *   walkover_to_x   the side that is here wins by walkover, through the same
 *                   WALKOVER event a scoring device sends (standings, brackets,
 *                   alerts as for any walkover); `deviceId` is the referee's own
 *                   scoring device, so a lease it holds is kept
 *   both_no_show    both absent and the rules allow more than a prompt: the call
 *                   is closed and the match goes back to the organiser (scheduled)
 * Only an answer the prompt offers is accepted.
 */
export async function answerNoShow(
  matchId: string,
  answer: NoShowAnswer,
  opts: { role: string; deviceId?: string | null; nowMs?: number; defer?: (task: () => Promise<void> | void) => void },
): Promise<Outcome<{ call: CallState; matchStatus: string }>> {
  const nowMs = opts.nowMs ?? Date.now();
  const open = await openCall(matchId, nowMs);
  if (!open.ok) return open;
  const { day, row } = open.value;
  const view = callView(asCourtCall(row), day.rules, nowMs);
  if (view.phase !== "no_show") return refuse(409, "not_due", "The no-show question comes when the deadline has passed with a side missing.");
  if (answer !== "wait" && !view.actions.includes(answer as CallAction)) {
    return refuse(409, "not_allowed", view.prompt?.kind === "both_absent" ? "Both sides are missing: extend, mark who arrived, or wait." : "That answer is not offered now.");
  }
  const at = new Date(nowMs).toISOString();
  const recorded: CallAnswer = { action: answer, at, by: opts.role };
  let matchStatus: string = day.match.status;

  if (answer === "wait") {
    await db().from("match_calls").update({ answer: recorded, updated_at: at }).eq("match_id", matchId).eq("status", "called");
  } else if (answer === "both_no_show") {
    const { data } = await db()
      .from("match_calls")
      .update({ status: "cancelled", answer: recorded, updated_at: at })
      .eq("match_id", matchId)
      .eq("status", "called")
      .select("match_id")
      .maybeSingle();
    if (!data) return refuse(409, "changed", "The call changed on another device. Reload.");
    await db().from("matches").update({ status: "scheduled", updated_at: at }).eq("id", matchId).eq("status", "ready");
    matchStatus = "scheduled";
    await cancelReminders(matchId);
  } else {
    const winner: TeamKey = answer === "walkover_to_a" ? "A" : "B";
    const done = await walkover(day.match, winner, { role: opts.role, deviceId: opts.deviceId ?? null, defer: opts.defer });
    if (!done.ok) return done;
    // The events path closed the call as a walkover; the answer says why.
    await db().from("match_calls").update({ answer: recorded, updated_at: at }).eq("match_id", matchId);
    await cancelReminders(matchId);
    matchStatus = "walkover";
  }
  await audit({
    tournament_id: day.match.tournament_id,
    actor_role: opts.role,
    action: "CALL_NO_SHOW_ANSWERED",
    entity_type: "match",
    entity_id: matchId,
    new_value: { answer, absent: view.absent, extensions: row.extensions },
  });
  const after = (await readCall(matchId)) ?? row;
  return { ok: true, status: 200, value: { call: toState(after, day.rules, nowMs), matchStatus } };
}

/** A walkover through the scoring path (src/lib/scoring/append.ts), as the referee console's own button sends it. */
async function walkover(
  match: Match,
  winner: TeamKey,
  opts: { role: string; deviceId: string | null; defer?: (task: () => Promise<void> | void) => void },
): Promise<Outcome<null>> {
  const winnerId = winner === "A" ? match.team_a_id : match.team_b_id;
  if (!winnerId) return refuse(409, "tbd", "Both sides must be known.");
  const [{ appendScoreEvents }, snapshot, { data: lastRow }, t] = await Promise.all([
    import("../scoring/append"),
    getSnapshot(match.id),
    db().from("score_events").select("event_number, new_state_json").eq("match_id", match.id).order("event_number", { ascending: false }).limit(1).maybeSingle(),
    getTournament(match.tournament_id),
  ]);
  const logged = lastRow as { event_number: number; new_state_json: Record<string, unknown> | null } | null;
  const last = Math.max(snapshot?.last_event_number ?? 0, logged?.event_number ?? 0);
  const previous = ((logged && logged.event_number >= (snapshot?.last_event_number ?? 0) ? logged.new_state_json : snapshot?.snapshot_json) ?? null) as Record<string, unknown> | null;
  let base: Record<string, unknown> | null = previous;
  if (!base) {
    if (sportOf(t ?? undefined).engine === "chess") {
      const { newChessState } = await import("../chess/engine");
      base = newChessState(t?.format_config?.legs === 2 ? 2 : 1) as unknown as Record<string, unknown>;
    } else {
      const { initialScoreState } = await import("../scoring/engine");
      base = initialScoreState("A") as unknown as Record<string, unknown>;
    }
  }
  const { randomUUID } = await import("crypto");
  const deviceId = (opts.deviceId && opts.deviceId.length <= 100 ? opts.deviceId : `call-${opts.role}`).slice(0, 100);
  const out = await appendScoreEvents(
    match,
    deviceId,
    [
      {
        client_event_id: randomUUID(),
        event_number: last + 1,
        event_type: "WALKOVER",
        team_id: winnerId,
        previous_state: previous as never,
        new_state: { ...base, matchOver: true, winner } as never,
        payload: { winner_team_id: winnerId, reason: "no_show" },
        created_at_client: new Date().toISOString(),
      },
    ],
    { role: opts.role, defer: opts.defer },
  );
  if (out.status !== 200) {
    const body = out.body as { error?: string; conflict?: string };
    return refuse(out.status, body.conflict ?? "refused", body.error ?? "The walkover was not recorded.");
  }
  return { ok: true, status: 200, value: null };
}

/** Withdraws a call (the organiser or referee called the wrong match): back to scheduled, reminders withdrawn. */
export async function cancelCall(matchId: string, opts: { role: string; nowMs?: number }): Promise<Outcome<{ call: CallState }>> {
  const nowMs = opts.nowMs ?? Date.now();
  const open = await openCall(matchId, nowMs);
  if (!open.ok) return open;
  const { day } = open.value;
  const at = new Date(nowMs).toISOString();
  const { data } = await db()
    .from("match_calls")
    .update({ status: "cancelled", answer: { action: "cancel", at, by: opts.role }, updated_at: at })
    .eq("match_id", matchId)
    .eq("status", "called")
    .select(CALL_COLUMNS)
    .maybeSingle();
  if (!data) return refuse(409, "changed", "The call changed on another device. Reload.");
  await db().from("matches").update({ status: "scheduled", updated_at: at }).eq("id", matchId).eq("status", "ready");
  await cancelReminders(matchId);
  await audit({ tournament_id: day.match.tournament_id, actor_role: opts.role, action: "CALL_CANCELLED", entity_type: "match", entity_id: matchId, new_value: null });
  return { ok: true, status: 200, value: { call: toState(data as CallRow, day.rules, nowMs) } };
}

/**
 * The match started (MATCH_STARTED) or was decided: its call is over and its
 * reminder withdrawn. Called by the events path; a match never called is a no-op.
 * Never throws.
 */
export async function closeCall(matchId: string, status: "started" | "walkover"): Promise<void> {
  try {
    const { data } = await db()
      .from("match_calls")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("match_id", matchId)
      .eq("status", "called")
      .select("match_id")
      .maybeSingle();
    if (data) await cancelReminders(matchId);
  } catch (err) {
    console.error("close call failed", err);
  }
}

/* ---------------- the players themselves ---------------- */

/** Which side of a match a signed-in account plays on, through its claimed player codes; null when neither. */
export async function sideOfUser(userId: string, match: Match): Promise<TeamKey | null> {
  const { data: claims } = await db().from("player_claims").select("player_id").eq("user_id", userId);
  const mine = new Set(((claims ?? []) as { player_id: string }[]).map((c) => c.player_id));
  if (!mine.size) return null;
  const sideOf = async (teamId: string | null, nominees: string[] | null | undefined): Promise<boolean> => {
    if (!teamId) return false;
    if (nominees?.length) return nominees.some((id) => mine.has(id));
    const { data } = await db().from("players").select("id").eq("team_id", teamId);
    return ((data ?? []) as { id: string }[]).some((p) => mine.has(p.id));
  };
  if (await sideOf(match.team_a_id, match.team_a_player_ids)) return "A";
  if (await sideOf(match.team_b_id, match.team_b_player_ids)) return "B";
  return null;
}

/**
 * "I'm at court" from the player's own phone. Only for a match the account plays
 * in (player_claims); anything else is "Not found", the same as a match that does
 * not exist.
 */
export async function markPresentAsPlayer(userId: string, matchId: string, nowMs = Date.now()): Promise<Outcome<{ side: TeamKey; call: CallState; changed: boolean }>> {
  const day = await dayOf(matchId);
  if (!day) return refuse(404, "not_found", "Not found");
  const side = await sideOfUser(userId, day.match);
  if (!side) return refuse(404, "not_found", "Not found");
  if (!day.rules.extras.imAtCourt) return refuse(409, "off", "This tournament does not use \"I'm at court\". Tell the referee you are here.");
  const r = await markPresent(matchId, side, { by: "player", role: "player", nowMs });
  if (!r.ok) return r;
  return { ok: true, status: 200, value: { side, call: r.value.call, changed: r.value.changed } };
}

/**
 * The player's own view of their match's call ("I'm at court" on the phone): which
 * side they play, whether the organiser uses "I'm at court", and the call's times
 * and presence. Only for a match the account plays in; anything else is "Not
 * found". Never the referee's prompt, actions or answer.
 */
export async function callForPlayer(
  userId: string,
  matchId: string,
): Promise<Outcome<{ side: TeamKey; imAtCourt: boolean; call: Pick<CallState, "status" | "calledAt" | "deadlineAt" | "presentA" | "presentB"> | null }>> {
  const day = await dayOf(matchId);
  if (!day) return refuse(404, "not_found", "Not found");
  const side = await sideOfUser(userId, day.match);
  if (!side) return refuse(404, "not_found", "Not found");
  const row = await readCall(matchId);
  const c = row ? toState(row, day.rules, Date.now()) : null;
  return {
    ok: true,
    status: 200,
    value: {
      side,
      imAtCourt: day.rules.courtCall.on && day.rules.extras.imAtCourt,
      call: c ? { status: c.status, calledAt: c.calledAt, deadlineAt: c.deadlineAt, presentA: c.presentA, presentB: c.presentB } : null,
    },
  };
}

/**
 * A match check-in scanned at the court (src/lib/pass/checkin.ts) by a player of
 * that match counts as "here" when the organiser turned that on. Silent: the
 * check-in answers as before whatever happens here. Never throws.
 */
export async function presentFromCheckIn(owner: { kind: "user" | "install"; id: string }, matchId: string): Promise<boolean> {
  try {
    if (owner.kind !== "user") return false;
    const day = await dayOf(matchId);
    if (!day || !day.rules.extras.qrCheckInPresent) return false;
    const row = await readCall(matchId);
    if (!row || row.status !== "called") return false;
    const side = await sideOfUser(owner.id, day.match);
    if (!side) return false;
    const r = await markPresent(matchId, side, { by: "qr", role: "player" });
    return r.ok;
  } catch (err) {
    console.error("check-in presence failed", err);
    return false;
  }
}
