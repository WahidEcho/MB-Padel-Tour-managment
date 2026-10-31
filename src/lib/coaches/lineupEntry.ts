/**
 * Coach line-up entry: the rules (pure, shared with the app through @core). Off unless an
 * admin turns it on for the event (Admin → Team coaches, `format_config.ties.coachLineups`):
 * while off, coaches are read only exactly as before (owner, 20 Oct 2026: "on the shelf"
 * until officially confirmed).
 *
 * When on, a coach (their team's code) names their own team's singles players (S1, S2;
 * the order of merit checked as for officials, Reg 43) and, if they wish, the doubles pair
 * ("to be named" until after the singles is the normal course). Their entry is a
 * submission, never the line-up itself: it is kept apart from the rubbers (no public page,
 * no opponent sees it) and the chair umpire, a master referee or the organiser confirms
 * it in their picker, which locks the line-ups. From the lock (or the event's deadline, if
 * one is set) the coach can only view; changes go through the officials as before.
 */
import type { RubberType } from "../types";
import { checkLineup, type LineupDraft, type LineupIssue, type SquadMember } from "../tennis/lineupRules";

export interface CoachLineupSettings {
  on: boolean;
  /** Minutes before the tie's time the coaches' entry closes; null: open until the lock. */
  deadlineMinutes: number | null;
}

export const COACH_LINEUPS_OFF: CoachLineupSettings = { on: false, deadlineMinutes: null };
export const COACH_DEADLINE_RANGE = { min: 0, max: 24 * 60 } as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The event's switch from its format_config; anything missing or malformed is off. */
export function coachLineupSettings(formatConfig: unknown): CoachLineupSettings {
  if (!isRecord(formatConfig) || !isRecord(formatConfig.ties)) return COACH_LINEUPS_OFF;
  const c = formatConfig.ties.coachLineups;
  if (!isRecord(c) || c.on !== true) return COACH_LINEUPS_OFF;
  return { on: true, deadlineMinutes: deadlineFrom(c.deadlineMinutes) };
}

/** A deadline as typed (minutes before the tie): a whole number in range, or null (until the lock). */
export function deadlineFrom(v: unknown): number | null {
  const n = typeof v === "string" ? (v.trim() === "" ? NaN : Number(v)) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(COACH_DEADLINE_RANGE.max, Math.max(COACH_DEADLINE_RANGE.min, Math.round(n)));
}

export type CoachLineupClosed = "feature_off" | "locked" | "deadline" | "under_way" | "opponent_unknown" | "finished";

export const COACH_LINEUP_CLOSED_MESSAGE: Record<CoachLineupClosed, string> = {
  feature_off: "Line-ups are entered by the chair umpire, a master referee or the organiser.",
  locked: "The line-ups are confirmed. Changes now go through the chair umpire or the master referee.",
  deadline: "The time for coaches to enter the line-up has passed. Ask the chair umpire or the master referee.",
  under_way: "The tie is under way. Changes go through the chair umpire or the master referee.",
  opponent_unknown: "The opponent of this tie is not known yet.",
  finished: "This tie is over.",
};

export interface CoachLineupWindow {
  open: boolean;
  closed: CoachLineupClosed | null;
  /** When the coaches' entry closes (ISO), when a deadline is set and the tie has a time. */
  deadline: string | null;
}

/** Whether the coach may enter or change their line-up now. */
export function coachLineupWindow(
  o: {
    settings: CoachLineupSettings;
    locked: boolean;
    tieStatus: "scheduled" | "live" | "completed";
    scheduledTime: string | null;
    opponentKnown: boolean;
    /** Both singles rubbers can still change (scheduled or ready). */
    singlesEditable: boolean;
  },
  now = Date.now(),
): CoachLineupWindow {
  const t = o.scheduledTime ? Date.parse(o.scheduledTime) : NaN;
  const deadline = o.settings.on && o.settings.deadlineMinutes !== null && Number.isFinite(t) ? new Date(t - o.settings.deadlineMinutes * 60_000).toISOString() : null;
  const close = (closed: CoachLineupClosed): CoachLineupWindow => ({ open: false, closed, deadline });
  if (!o.settings.on) return { open: false, closed: "feature_off", deadline: null };
  if (o.tieStatus === "completed") return close("finished");
  if (o.locked) return close("locked");
  if (o.tieStatus !== "scheduled" || !o.singlesEditable) return close("under_way");
  if (!o.opponentKnown) return close("opponent_unknown");
  if (deadline && Date.parse(deadline) <= now) return close("deadline");
  return { open: true, closed: null, deadline };
}

/** How officials and audit rows name the coach: "Coach of Egypt". */
export function coachActorLabel(teamName: string): string {
  return `Coach of ${teamName.trim() || "the team"}`;
}

/** "10:32" in the event's time zone. */
export function clockIn(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** The officials' picker note: "Submitted by the coach at 10:32". */
export function submittedNote(iso: string, timeZone: string): string {
  return `Submitted by the coach at ${clockIn(iso, timeZone)}`;
}

/**
 * The coach's line-up checked as the officials' is (lineupRules.ts): both singles named,
 * the doubles pair complete or to be named. `retired`/`open` as for checkLineup.
 */
export function checkCoachLineup(lineup: LineupDraft, squad: SquadMember[], ctx: { retired?: string[]; open?: RubberType[] } = {}) {
  return checkLineup(lineup, squad, { ...ctx, requireSingles: true });
}

/** The warnings a submission brings that the coach had not accepted in their last one (only those are alerted again). */
export function newlyAccepted(warnings: LineupIssue[], before: readonly string[] | null | undefined): LineupIssue[] {
  const had = new Set(before ?? []);
  return warnings.filter((w) => !had.has(w.key));
}

/** Two line-ups name the same players in the same places. */
export function sameLineup(a: LineupDraft | null | undefined, b: LineupDraft | null | undefined): boolean {
  const norm = (l: LineupDraft | null | undefined) => (l ? [l.S1 ?? null, l.S2 ?? null, ...(l.D ?? []).filter(Boolean)] : null);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
