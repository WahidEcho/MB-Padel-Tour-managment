/**
 * Calling a match to its court (Phase 3): what the referee, the players and the
 * screens see from the moment the match is called until it starts.
 *
 *   called        the players have `courtCall.minutes` to reach the court
 *   reminder      `courtCall.reminderMinutes` before the deadline (default −2 min)
 *   overdue       the deadline passed with a side missing and no-show prompts off
 *   no_show       the deadline passed with a side missing: the referee is asked.
 *                 Each extension adds `noShow.extensionMinutes` (default +5) up
 *                 to `noShow.maxExtensions`. With both sides absent and
 *                 `bothAbsentPromptOnly` the prompt offers no walkover, only the
 *                 extension and marking players present.
 *   all_present   both sides are at the court: ready to start
 *   closed        the match started (or the call was withdrawn)
 *
 * The server stores the call (match_calls) and sends the alerts; this module only
 * says what a stored call looks like at an instant, so the referee phone, the web
 * console and the server agree without talking to each other.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import type { TeamKey } from "../scoring/engine";
import type { MatchDayRules } from "./rules";

const MINUTE = 60_000;

/** A call as stored. Times are epoch ms or ISO strings. */
export interface CourtCall {
  calledAt: number | string;
  /** Extensions granted so far. */
  extensions: number;
  presentA: boolean;
  presentB: boolean;
  /** Set when the call is over: the match started or the call was withdrawn. */
  closedAt?: number | string | null;
}

export type CallPhase = "called" | "reminder" | "overdue" | "no_show" | "all_present" | "closed";

export type CallAction =
  | "mark_present_a"
  | "mark_present_b"
  | "extend"
  | "walkover_to_a"
  | "walkover_to_b"
  /** Both sides absent and the rules allow more than a prompt: record both as no-shows. */
  | "both_no_show"
  | "start_match";

export interface NoShowPrompt {
  kind: "one_absent" | "both_absent";
  absent: TeamKey[];
}

export interface CallView {
  phase: CallPhase;
  calledAt: number;
  /** The current deadline, extensions included. */
  deadlineAt: number;
  reminderAt: number;
  /** Until the deadline, never below 0. */
  msLeft: number;
  extensionsUsed: number;
  extensionsLeft: number;
  canExtend: boolean;
  absent: TeamKey[];
  /** The no-show question, at and after the deadline only. */
  prompt: NoShowPrompt | null;
  /** What the referee can do now. */
  actions: CallAction[];
  /** When this view next changes on its own (reminder, deadline); null when only an action changes it. */
  nextChangeAt: number | null;
}

function ms(t: number | string | null | undefined): number | null {
  if (t === null || t === undefined) return null;
  const v = typeof t === "number" ? t : Date.parse(t);
  return Number.isFinite(v) ? v : null;
}

function extensionsUsed(call: CourtCall, rules: MatchDayRules): number {
  const n = Number.isFinite(call.extensions) ? Math.max(0, Math.floor(call.extensions)) : 0;
  return Math.min(n, rules.noShow.maxExtensions);
}

/** The deadline: called + minutes + extensions × extension minutes. */
export function callDeadline(call: CourtCall, rules: MatchDayRules): number {
  const calledAt = ms(call.calledAt) ?? 0;
  return calledAt + rules.courtCall.minutes * MINUTE + extensionsUsed(call, rules) * rules.noShow.extensionMinutes * MINUTE;
}

/** When the reminder goes out: `reminderMinutes` before the current deadline, never before the call. */
export function callReminderAt(call: CourtCall, rules: MatchDayRules): number {
  const calledAt = ms(call.calledAt) ?? 0;
  return Math.max(calledAt, callDeadline(call, rules) - rules.courtCall.reminderMinutes * MINUTE);
}

/** The call at an instant. */
export function callView(call: CourtCall, rules: MatchDayRules, nowMs: number): CallView {
  const calledAt = ms(call.calledAt) ?? 0;
  const deadlineAt = callDeadline(call, rules);
  const reminderAt = callReminderAt(call, rules);
  const used = extensionsUsed(call, rules);
  const extensionsLeft = Math.max(0, rules.noShow.maxExtensions - used);
  const absent: TeamKey[] = [];
  if (!call.presentA) absent.push("A");
  if (!call.presentB) absent.push("B");
  const closed = ms(call.closedAt) !== null;
  const base = {
    calledAt,
    deadlineAt,
    reminderAt,
    msLeft: Math.max(0, deadlineAt - nowMs),
    extensionsUsed: used,
    extensionsLeft,
    absent,
  };

  if (closed) {
    return { ...base, phase: "closed", canExtend: false, prompt: null, actions: [], nextChangeAt: null };
  }
  const markPresent: CallAction[] = absent.map((t) => (t === "A" ? "mark_present_a" : "mark_present_b"));
  if (absent.length === 0) {
    return { ...base, phase: "all_present", canExtend: false, prompt: null, actions: ["start_match"], nextChangeAt: null };
  }

  if (nowMs < deadlineAt) {
    const reminding = nowMs >= reminderAt;
    return {
      ...base,
      phase: reminding ? "reminder" : "called",
      canExtend: false,
      prompt: null,
      actions: markPresent,
      nextChangeAt: reminding ? deadlineAt : reminderAt,
    };
  }

  if (!rules.noShow.on) {
    return { ...base, phase: "overdue", canExtend: false, prompt: null, actions: markPresent, nextChangeAt: null };
  }

  const canExtend = extensionsLeft > 0;
  const actions: CallAction[] = [...markPresent];
  if (canExtend) actions.push("extend");
  let prompt: NoShowPrompt;
  if (absent.length === 1) {
    prompt = { kind: "one_absent", absent };
    // The side that is here takes the walkover.
    actions.push(absent[0] === "A" ? "walkover_to_b" : "walkover_to_a");
  } else {
    prompt = { kind: "both_absent", absent };
    if (!rules.noShow.bothAbsentPromptOnly) actions.push("both_no_show");
  }
  return { ...base, phase: "no_show", canExtend, prompt, actions, nextChangeAt: null };
}

export type ExtendRefusal = "closed" | "no_show_off" | "not_due" | "max_extensions" | "all_present";

/**
 * One more extension, as the referee's "+5 min". Allowed only at or after the
 * deadline (the no-show prompt), with someone absent, below the maximum.
 */
export function extendCall(
  call: CourtCall,
  rules: MatchDayRules,
  nowMs: number,
): { ok: true; call: CourtCall; deadlineAt: number } | { ok: false; reason: ExtendRefusal } {
  const view = callView(call, rules, nowMs);
  if (view.phase === "closed") return { ok: false, reason: "closed" };
  if (view.phase === "all_present") return { ok: false, reason: "all_present" };
  if (!rules.noShow.on) return { ok: false, reason: "no_show_off" };
  if (view.phase !== "no_show") return { ok: false, reason: "not_due" };
  if (!view.canExtend) return { ok: false, reason: "max_extensions" };
  const next = { ...call, extensions: view.extensionsUsed + 1 };
  return { ok: true, call: next, deadlineAt: callDeadline(next, rules) };
}

/**
 * Whether the reminder is due now and not yet sent for this deadline. The server
 * stores the deadline it last reminded for, so an extension earns a new reminder.
 */
export function reminderDue(call: CourtCall, rules: MatchDayRules, nowMs: number, remindedForDeadline: number | null): boolean {
  const view = callView(call, rules, nowMs);
  return view.phase === "reminder" && remindedForDeadline !== view.deadlineAt;
}
