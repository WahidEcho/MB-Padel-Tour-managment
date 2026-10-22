/**
 * The scoring console's words that the shared engine (@core) writes in English,
 * in the app's language: rule summaries, timer and ruling labels, code
 * violations, log chips and why a result was refused. Mapped by code/kind, so
 * the shared code (also the web's) stays as it is. Pure (no React Native).
 */
import type { MatchRules, ResultProblem, TimeDecision, TimerKind } from "@core";
import { getLang, tr, type Key, type Params } from "../i18n/t";

/** One line of the match's rules under the score (describeMatchRules, in the app's language). */
export function rulesText(rules: MatchRules): string {
  const parts = [rules.setsToWinMatch === 1 ? tr("score.rulesOneSet") : tr("score.rulesBestOf", { n: rules.setsToWinMatch * 2 - 1 }), tr("score.rulesFirstTo", { n: rules.gamesToWinSet })];
  if (rules.tiebreakEnabled) {
    const advantage = rules.tiebreakAtGames > rules.gamesToWinSet;
    parts.push(tr(advantage ? "score.rulesAdvTiebreak" : "score.rulesTiebreak", { points: rules.tiebreakTargetPoints, games: rules.tiebreakAtGames }));
  } else parts.push(tr("score.rulesNoTiebreak"));
  if (rules.matchTiebreak && rules.setsToWinMatch > 1) parts.push(tr("score.rulesMatchTiebreak", { points: rules.matchTiebreakPoints || 10, count: rules.setsToWinMatch - 1 }));
  if (rules.decidingPoint) parts.push(tr("score.rulesNoAd"));
  return parts.join(" · ");
}

/** "the MATCH" / "the set" / "this game" from the engine's pointNeedsConfirm. */
export function winWhat(what: string): string {
  if (/match/i.test(what)) return tr("score.winMatch");
  if (/set/i.test(what)) return tr("score.winSet");
  if (/game/i.test(what)) return tr("score.winGame");
  return what;
}

export const timerLabel = (k: TimerKind) => tr(`score.timer_${k}` as Key);
export const decisionLabel = (d: TimeDecision) => tr(`score.decision_${d}` as Key);
export const offenceLabel = (o: string) => tr(`score.offence_${o}` as Key);
export const penaltyLabel = (p: string) => tr(`score.penalty_${p}` as Key);

const CHIPS: Record<string, string> = {
  ACE: "ace",
  "DOUBLE FAULT": "double_fault",
  FAULT: "fault",
  LET: "let",
  VIOLATION: "violation",
  TIME: "time",
  UNDO: "undo",
  ENDED: "ended",
  WALKOVER: "walkover",
  RETIRED: "retired",
  DEFAULT: "default",
  RESULT: "result",
  TIMER: "timer",
  "25 S": "25s",
  CHANGEOVER: "changeover",
  "SET BREAK": "set_break",
  BREAK: "break",
  BATHROOM: "bathroom",
  HYDRATION: "hydration",
  MEDICAL: "medical",
};

/** A match-log chip (buildMatchLog's English label) in the app's language. */
export function chipText(chip: string): string {
  const k = CHIPS[chip];
  return k ? tr(`score.chip_${k}` as Key) : chip;
}

const PROBLEMS = new Set([
  "rules",
  "no_sets",
  "not_whole_number",
  "set_score",
  "tiebreak_required",
  "tiebreak_not_allowed",
  "tiebreak_score",
  "after_match_over",
  "unfinished",
  "unreachable",
  "no_games",
  "wrong_game_count",
  "not_a_result",
  "mode",
  "payload",
  "draw_unsupported",
  "advance_not_allowed",
  "advance_not_needed",
  "state_mismatch",
  "winner_mismatch",
  "not_playable",
]);
/** Problems about one set that read "Set 2: …". */
const PER_SET = new Set(["not_whole_number", "set_score", "tiebreak_required", "tiebreak_not_allowed", "tiebreak_score", "after_match_over"]);

/**
 * Why a result is refused. English keeps the shared engine's own, more precise
 * message (with the scores in it); Spanish and French say it by the problem's code.
 */
export function problemText(p: Pick<ResultProblem, "code" | "set" | "message">): string {
  if (getLang() === "en" || !PROBLEMS.has(p.code)) return p.message;
  const text = tr(`score.problem_${p.code}` as Key);
  if (PER_SET.has(p.code) && p.set !== null && p.set !== undefined) return tr("score.problemSet", { set: tr("score.setN", { n: p.set + 1 }), text });
  return text;
}

/**
 * A sentence with some names in bold: splits `key`'s words around the
 * placeholders in `bold` (word order differs between languages).
 */
export function richParts(key: Key, params: Params, bold: string[]): { text: string; bold: boolean }[] {
  const marked = tr(key, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, bold.includes(k) ? `\u0000${k}\u0000` : v])));
  return marked
    .split("\u0000")
    .filter((s) => s !== "")
    .map((s) => (bold.includes(s) && s in params ? { text: String(params[s] ?? ""), bold: true } : { text: s, bold: false }));
}
