/**
 * Line-up checks for a tie, as problems and warnings. Pure (shared with the app
 * through @core): the server's setLineup, the chair umpire's pickers (web and app)
 * and the Excel preview all use it, so every surface says the same words.
 *
 * - A problem refuses the line-up (a player in both singles, someone not in the
 *   squad, half a doubles pair).
 * - A warning lets it through once accepted (owner's decision, Junior Finals 2026):
 *   the order of merit (ITF Reg. 43) and a player named again after retiring in the
 *   tie (ITF Reg. 50). The chair umpire may accept a warning himself; the master
 *   referees and the organiser are told at once (src/lib/tennis/lineupServer.ts).
 *
 * Every issue names its regulation, so a surface can link "ITF Reg. 43" to the
 * regulation page (src/lib/tennis/regulations.ts).
 */
import type { MatchStatus, RubberType, Tie } from "../types";
import { regulationLabel } from "./regulations";

export interface LineupDraft {
  S1: string | null;
  S2: string | null;
  D: (string | null)[];
}

/** A squad in the nation's order of merit, No. 1 first. */
export interface SquadMember {
  id: string;
  name: string;
}

export type LineupIssueCode =
  | "missing_s1"
  | "missing_s2"
  | "same_singles"
  | "not_in_squad"
  | "doubles_incomplete"
  | "doubles_same"
  | "order_of_merit"
  | "retired_again";

export interface LineupIssue {
  code: LineupIssueCode;
  /** The ITF regulation it comes from ("43"), for the link. */
  reg: string | null;
  /** Plain words, without the regulation (the surface adds the link after it). */
  message: string;
  /** The rubbers it concerns: a warning only counts when one of them changes. */
  rubbers: RubberType[];
  /** Stable for the same line-up: what an acceptance names. */
  key: string;
  /** For the notification: "Omar plays Singles 1 above Ali". */
  summary?: string;
}

export interface LineupCheck {
  problems: LineupIssue[];
  warnings: LineupIssue[];
}

export const EMPTY_LINEUP: LineupDraft = { S1: null, S2: null, D: [null, null] };

const RUBBER_WORDS: Record<RubberType, string> = { S1: "Singles 1", S2: "Singles 2", D: "the doubles" };

/** "Ali Hassan (No. 1) …": the message with its regulation, for plain-text surfaces. */
export function issueText(issue: Pick<LineupIssue, "message" | "reg">): string {
  return issue.reg ? `${issue.message} ${regulationLabel(issue.reg)}.` : issue.message;
}

/** "Omar plays Singles 1 above Ali (ITF Reg. 43)": what the master referees are told. */
export function exceptionLine(issue: Pick<LineupIssue, "summary" | "message" | "reg">): string {
  const what = issue.summary ?? issue.message.replace(/\.$/, "");
  return issue.reg ? `${what} (${regulationLabel(issue.reg)})` : what;
}

/** The doubles pair, or null while it is still to be named. */
export function doublesOf(l: Pick<LineupDraft, "D">): string[] | null {
  const d = (l.D ?? []).filter(Boolean) as string[];
  return d.length ? d : null;
}

/**
 * Checks one side's line-up against its squad (in order of merit). `retired`: the
 * side's players who retired earlier in this tie (retiredInTie, Reg 50); `open`:
 * the rubbers still to play (a retired player named only in a finished rubber is
 * history, not a warning). `requireSingles` is false for a doubles-only step.
 */
export function checkLineup(
  lineup: LineupDraft,
  squad: SquadMember[],
  opts: { retired?: string[]; open?: RubberType[]; requireSingles?: boolean } = {},
): LineupCheck {
  const problems: LineupIssue[] = [];
  const warnings: LineupIssue[] = [];
  const rank = (id: string | null | undefined) => (id ? squad.findIndex((p) => p.id === id) : -1);
  const name = (id: string) => squad.find((p) => p.id === id)?.name ?? "That player";
  const inSquad = (id: string | null | undefined) => rank(id) >= 0;
  const requireSingles = opts.requireSingles !== false;

  if (requireSingles && !lineup.S1) problems.push({ code: "missing_s1", reg: "43", message: "Choose the Singles 1 player.", rubbers: ["S1"], key: "missing_s1" });
  if (requireSingles && !lineup.S2) problems.push({ code: "missing_s2", reg: "43", message: "Choose the Singles 2 player.", rubbers: ["S2"], key: "missing_s2" });
  for (const [type, id] of [["S1", lineup.S1], ["S2", lineup.S2]] as const) {
    if (id && !inSquad(id)) problems.push({ code: "not_in_squad", reg: null, message: `The ${RUBBER_WORDS[type]} player is not in this nation's squad.`, rubbers: [type], key: `not_in_squad:${type}` });
  }
  if (lineup.S1 && lineup.S1 === lineup.S2) {
    problems.push({ code: "same_singles", reg: "43", message: "One player cannot play both singles.", rubbers: ["S1", "S2"], key: "same_singles" });
  } else if (inSquad(lineup.S1) && inSquad(lineup.S2) && rank(lineup.S1) > rank(lineup.S2)) {
    const hi = lineup.S2!;
    const lo = lineup.S1!;
    warnings.push({
      code: "order_of_merit",
      reg: "43",
      message: `${name(hi)} (No. ${rank(hi) + 1}) is ranked above ${name(lo)} (No. ${rank(lo) + 1}), so ${name(hi)} should play Singles 1.`,
      summary: `${name(lo)} plays Singles 1 above ${name(hi)}`,
      rubbers: ["S1", "S2"],
      key: `order_of_merit:${lo}>${hi}`,
    });
  }

  const d = (lineup.D ?? []).filter(Boolean) as string[];
  if (d.length > 0) {
    if (d.length !== 2 || !d.every(inSquad)) {
      problems.push({ code: "doubles_incomplete", reg: "43", message: "Choose two players for the doubles, or leave it to be named.", rubbers: ["D"], key: "doubles_incomplete" });
    } else if (d[0] === d[1]) {
      problems.push({ code: "doubles_same", reg: "43", message: "The doubles needs two different players.", rubbers: ["D"], key: "doubles_same" });
    }
  }

  // Reg 50: a player who retired earlier in the tie, named for a rubber still to play.
  const open = new Set(opts.open ?? (["S1", "S2", "D"] as RubberType[]));
  for (const pid of [...new Set(opts.retired ?? [])]) {
    const where = (["S1", "S2", "D"] as RubberType[]).filter((t) => open.has(t) && (t === "D" ? d.includes(pid) : lineup[t] === pid));
    if (!where.length) continue;
    warnings.push({
      code: "retired_again",
      reg: "50",
      message: `${name(pid)} retired earlier in this tie, so playing ${where.map((t) => RUBBER_WORDS[t]).join(" and ")} needs the Referee's agreement.`,
      summary: `${name(pid)} plays ${where.map((t) => RUBBER_WORDS[t]).join(" and ")} after retiring earlier in the tie`,
      rubbers: where,
      key: `retired_again:${pid}`,
    });
  }
  return { problems, warnings };
}

/** The rubbers whose players a new line-up changes, against what the rubbers hold now. */
export function changedRubbers(current: LineupDraft, next: LineupDraft): RubberType[] {
  const out: RubberType[] = [];
  if ((current.S1 ?? null) !== (next.S1 ?? null)) out.push("S1");
  if ((current.S2 ?? null) !== (next.S2 ?? null)) out.push("S2");
  if (JSON.stringify(doublesOf(current) ?? []) !== JSON.stringify(doublesOf(next) ?? [])) out.push("D");
  return out;
}

/** The warnings a change brings: those about a rubber it changes (an untouched rubber's was accepted before). */
export function warningsForChange(check: LineupCheck, changed: RubberType[]): LineupIssue[] {
  return check.warnings.filter((w) => w.rubbers.some((r) => changed.includes(r)));
}

/** Warnings not covered by the acceptances sent with the request. */
export function unaccepted(warnings: LineupIssue[], accepted: readonly string[] | null | undefined, side?: "A" | "B"): LineupIssue[] {
  const set = new Set(accepted ?? []);
  return warnings.filter((w) => !set.has(side ? `${side}:${w.key}` : w.key) && !set.has(w.key));
}

/**
 * Whether a change after the line-ups were confirmed (locked) needs a reason: any
 * change of a named player. Naming the doubles pair for the first time after the
 * singles is the normal course (Reg 43) and needs none.
 */
export function needsReason(locked: boolean, current: LineupDraft, next: LineupDraft): boolean {
  if (!locked) return false;
  const changed = changedRubbers(current, next);
  if (!changed.length) return false;
  return !(changed.length === 1 && changed[0] === "D" && !doublesOf(current));
}

/* ---------------- the chair umpire's picker ---------------- */

export interface StepRubber {
  type: RubberType;
  status: MatchStatus;
}

export type LineupStep =
  /** Before the tie: both nations' singles players. */
  | "singles"
  /** The singles are named and still to finish; the doubles pair comes after them. */
  | "doubles_later"
  /** The singles are over: name the doubles pair. */
  | "doubles"
  /** Everything named (or nothing left that can change). */
  | "done";

const FINISHED: MatchStatus[] = ["completed", "walkover", "disqualified", "retired", "cancelled"];
export const rubberEditable = (status: MatchStatus) => status === "scheduled" || status === "ready";

/** Which step the chair umpire's line-up screen is on. */
export function lineupStep(rubbers: StepRubber[], lineups: { A: LineupDraft; B: LineupDraft }): LineupStep {
  const r = (t: RubberType) => rubbers.find((x) => x.type === t);
  const singlesNamed = (["A", "B"] as const).every((s) => lineups[s].S1 && lineups[s].S2);
  const singlesOpen = (["S1", "S2"] as RubberType[]).some((t) => r(t) && rubberEditable(r(t)!.status));
  if (!singlesNamed && singlesOpen) return "singles";
  const d = r("D");
  const doublesNamed = (["A", "B"] as const).every((s) => doublesOf(lineups[s])?.length === 2);
  if (!d || !rubberEditable(d.status) || doublesNamed) return "done";
  const singlesOver = (["S1", "S2"] as RubberType[]).every((t) => !r(t) || FINISHED.includes(r(t)!.status));
  return singlesOver ? "doubles" : "doubles_later";
}

/* ---------------- what the picker route answers (web console and app) ---------------- */

export interface PickerSide {
  teamId: string;
  nation: string;
  code: string | null;
  iso2: string | null;
  /** In the order of merit, No. 1 first. */
  squad: SquadMember[];
  lineup: LineupDraft;
  retired: string[];
  open: RubberType[];
}

export interface LineupPickerModel {
  matchId: string;
  tie: { id: string; tournamentId: string; tournamentName: string; round: string | null; court: string | null; locked: boolean; status: Tie["status"] };
  rubbers: { id: string; type: RubberType; label: string; status: MatchStatus; editable: boolean }[];
  sides: Record<"A" | "B", PickerSide>;
  step: LineupStep;
  actor: "organiser" | "master" | "court";
  /**
   * A coach's submitted line-up per side (coach line-up entry, only while the event's switch
   * is on). `pending`: newer than what the officials last saved for that side and not yet
   * confirmed (the picker prefills it; confirming it locks the line-ups). `note`: "Submitted
   * by the coach at 10:32" (the event's time zone).
   */
  coach?: Partial<Record<"A" | "B", PickerCoachSubmission>>;
}

export interface PickerCoachSubmission {
  lineup: LineupDraft;
  at: string;
  note: string;
  by: string;
  pending: boolean;
  /** The warnings the coach accepted with it (the official accepts them again to confirm). */
  accepted: { code: LineupIssueCode; reg: string | null; message: string }[];
}
