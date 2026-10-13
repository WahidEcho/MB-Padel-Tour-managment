/**
 * What the referee's call card shows (plan Phase 5): the Move Score app's
 * CallCard and the web console's, from the same stored call and the same rules,
 * so both consoles say the same thing at the same second.
 *
 *   callCardModel   whether the card shows, its headline, the countdown, who is at
 *                   the court, whether the match can be called now, and the
 *                   no-show question once the deadline has passed
 *   noShowOptions   the answers the no-show sheet offers, in order: mark who
 *                   arrived is on the card; the sheet has keep waiting, +N min
 *                   (up to the maximum), the walkover to the side that is here,
 *                   and — both absent, only when the rules allow more than a
 *                   prompt — both no-shows. Both absent never offers a walkover.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import type { TeamKey } from "../scoring/engine";
import type { MatchDayRules } from "./rules";
import { callView, type CallPhase, type CallView, type CourtCall } from "./call";

/** A stored call as the call route and the referee bootstrap send it. Times are ISO strings. */
export interface CallSnapshot {
  status: "called" | "started" | "walkover" | "cancelled";
  calledAt: string;
  deadlineAt?: string;
  extensions: number;
  presentA: boolean;
  presentB: boolean;
  /** When the row last changed: the moment a closed call closed. */
  updatedAt?: string | null;
}

export type NoShowChoice = "wait" | "extend" | "walkover_to_a" | "walkover_to_b" | "both_no_show";

export interface NoShowOption {
  choice: NoShowChoice;
  label: string;
  detail: string;
  /** Ends the match (or sends it back): asked a second time before it is sent. */
  danger: boolean;
  /** The second question, for a danger option. */
  confirm: string | null;
}

export interface CallCardSide {
  key: TeamKey;
  name: string;
  present: boolean;
  /** The referee can mark this side as at the court. */
  canMark: boolean;
}

export interface CallCardModel {
  /** Court calls are on for this tournament and the match is waiting to start. */
  show: boolean;
  /** Not called (or the call was withdrawn): the referee can call it now. */
  canCall: boolean;
  phase: CallPhase | "not_called";
  title: string;
  detail: string;
  /** m:ss until the deadline; null when there is no running call. */
  countdown: string | null;
  /** The deadline is close or passed: the countdown in the alert colour. */
  urgent: boolean;
  sides: CallCardSide[];
  /** The no-show question: at and after the deadline with a side missing (rules permitting). */
  noShow: NoShowOption[] | null;
  /** The referee can withdraw the call (the wrong match was called). */
  canCancel: boolean;
  view: CallView | null;
  /** Every second while the call is running (the countdown); null when nothing moves on its own. */
  tickMs: number | null;
}

const WAITING = new Set(["scheduled", "ready"]);

/** 4:05, never negative. */
export function callClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The pure call module's input from a stored call. */
export function courtCallOf(c: CallSnapshot): CourtCall {
  return {
    calledAt: c.calledAt,
    extensions: c.extensions,
    presentA: c.presentA,
    presentB: c.presentB,
    closedAt: c.status === "called" ? null : (c.updatedAt ?? c.calledAt),
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The no-show sheet's answers for a view at the no-show prompt; empty anywhere else. */
export function noShowOptions(view: CallView, rules: MatchDayRules, names: Record<TeamKey, string>): NoShowOption[] {
  if (view.phase !== "no_show" || !view.prompt) return [];
  const out: NoShowOption[] = [
    { choice: "wait", label: "Keep waiting", detail: "Nothing changes. Ask again whenever you like.", danger: false, confirm: null },
  ];
  if (view.actions.includes("extend")) {
    out.push({
      choice: "extend",
      label: `+${rules.noShow.extensionMinutes} min`,
      detail: `A new deadline and a reminder to the players. ${plural(view.extensionsLeft, "extension")} left.`,
      danger: false,
      confirm: null,
    });
  }
  for (const [action, winner] of [
    ["walkover_to_a", "A"],
    ["walkover_to_b", "B"],
  ] as const) {
    if (!view.actions.includes(action)) continue;
    const loser: TeamKey = winner === "A" ? "B" : "A";
    out.push({
      choice: action,
      label: `Walkover to ${names[winner]}`,
      detail: `${names[loser]} did not come to the court. ${names[winner]} wins by walkover.`,
      danger: true,
      confirm: `Give ${names[winner]} the match by walkover? The result goes to the standings, the draw and the screens.`,
    });
  }
  if (view.actions.includes("both_no_show")) {
    out.push({
      choice: "both_no_show",
      label: "Neither side came",
      detail: "The call is closed and the match goes back to the organiser.",
      danger: true,
      confirm: "Record both sides as absent and hand the match back to the organiser?",
    });
  }
  return out;
}

/** The referee's call card at an instant. */
export function callCardModel(input: {
  call: CallSnapshot | null;
  rules: MatchDayRules;
  nowMs: number;
  matchStatus: string;
  hasCourt: boolean;
  names: Record<TeamKey, string>;
}): CallCardModel {
  const { call, rules, nowMs, matchStatus, hasCourt, names } = input;
  const open = call?.status === "called";
  const waiting = WAITING.has(matchStatus);
  const hidden: CallCardModel = {
    show: false,
    canCall: false,
    phase: "not_called",
    title: "",
    detail: "",
    countdown: null,
    urgent: false,
    sides: [],
    noShow: null,
    canCancel: false,
    view: null,
    tickMs: null,
  };
  if (!rules.courtCall.on || !waiting) return hidden;

  if (!open) {
    const before = call?.status === "cancelled" ? "The call was withdrawn. " : "";
    return {
      ...hidden,
      show: true,
      canCall: hasCourt,
      title: "Not called yet",
      detail: hasCourt
        ? `${before}Calling it gives the players ${plural(rules.courtCall.minutes, "minute")} to reach the court.`
        : `${before}Give the match a court first (tournament desk).`,
      sides: (["A", "B"] as TeamKey[]).map((key) => ({ key, name: names[key], present: false, canMark: false })),
    };
  }

  const view = callView(courtCallOf(call), rules, nowMs);
  const sides: CallCardSide[] = (["A", "B"] as TeamKey[]).map((key) => {
    const present = key === "A" ? call.presentA : call.presentB;
    return { key, name: names[key], present, canMark: !present && view.actions.includes(key === "A" ? "mark_present_a" : "mark_present_b") };
  });
  const missing = view.absent.map((k) => names[k]);
  const base = { ...hidden, show: true, phase: view.phase, sides, view, canCancel: view.phase !== "closed" };

  switch (view.phase) {
    case "all_present":
      return { ...base, title: "Both sides are here", detail: "Start the match when you are ready.", countdown: null };
    case "called":
    case "reminder":
      return {
        ...base,
        title: view.phase === "reminder" ? "Called · reminder sent" : "Called to court",
        detail: missing.length ? `Waiting for ${missing.join(" and ")}.` : "",
        countdown: callClock(view.msLeft),
        urgent: view.phase === "reminder",
        tickMs: 1000,
      };
    case "overdue":
      return {
        ...base,
        title: "Deadline passed",
        detail: `${missing.join(" and ")} not at the court yet. Mark them when they arrive.`,
        countdown: callClock(0),
        urgent: true,
      };
    case "no_show": {
      const both = view.prompt?.kind === "both_absent";
      return {
        ...base,
        title: both ? "Neither side is here" : `${missing[0]} is not here`,
        detail: both
          ? view.actions.includes("both_no_show")
            ? "Extend, mark who arrived, or record both as absent."
            : "Extend or mark who arrived. With both sides missing there is no walkover."
          : view.canExtend
            ? "Extend the deadline, mark them present, or give the walkover."
            : "No more extensions. Mark them present or give the walkover.",
        countdown: callClock(0),
        urgent: true,
        noShow: noShowOptions(view, rules, names),
      };
    }
    default:
      return { ...hidden };
  }
}
