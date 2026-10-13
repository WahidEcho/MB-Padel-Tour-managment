/**
 * Final-result entry: a match recorded as its set scores instead of point by
 * point (Phase 2). The referee, organiser or admin types 6-4 7-6(5); this module
 * says whether that score can happen under the match's own rules and builds the
 * final engine state from it, so standings, brackets, points and screens read a
 * result entered this way exactly as they read one scored point by point.
 *
 * The state is built with the real engine (`awardGame` for games, `awardPoint`
 * for tie-break points), never assembled by hand. `awardGame` inside a
 * tie-break ends the set with a 0-0 tie-break (it is the game-penalty path), so
 * tie-break sets are played point by point here to keep their points.
 *
 * Shape of an entered set (side A first, as everywhere else):
 *   6-4               { a: 6, b: 4 }
 *   7-6(5)            { a: 7, b: 6, tb: { a: 7, b: 5 } }   tie-break points REQUIRED
 *   [10-8] decider    { a: 1, b: 0, tb: { a: 10, b: 8 } }  as the engine records it;
 *                     `matchTiebreakSet(10, 8)` builds it. The games of a match
 *                     tie-break are always 1-0 to its winner.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import type { CompletedSet, MatchRules } from "../types";
import { awardGame, awardPoint, formatSet, initialScoreState, type ScoreState, type TeamKey } from "./engine";
import { validateMatchRules } from "./rules";

export interface EnteredSet {
  a: number;
  b: number;
  /** Tie-break points, both sides. Required exactly when the set ended in a tie-break or is a match tie-break. */
  tb?: { a: number; b: number } | null;
}

export type FinalScoreProblemCode =
  /** The match's rules themselves are inconsistent (see validateMatchRules). */
  | "rules"
  | "no_sets"
  /** A score that is not a whole number of at least 0. */
  | "not_whole_number"
  /** A set score the rules cannot produce (6-5, 8-6 with a tie-break at 6-6, 7-3 …). */
  | "set_score"
  | "tiebreak_required"
  /** Tie-break points on a set that did not end in a tie-break. */
  | "tiebreak_not_allowed"
  /** Tie-break points the rules cannot produce, or that disagree with who won the set. */
  | "tiebreak_score"
  /** A set entered after one side had already won the match. */
  | "after_match_over"
  /** Nobody has won the match yet. */
  | "unfinished"
  /** The engine did not arrive at the entered score (a bug guard; should never fire). */
  | "unreachable";

export interface FinalScoreProblem {
  code: FinalScoreProblemCode;
  /** 0-based index of the set the problem is about; null for the match as a whole. */
  set: number | null;
  message: string;
}

/** What kind of set is played next, given the sets entered so far. */
export type SetKind = "set" | "match_tiebreak";

const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

function setTarget(rules: MatchRules): number {
  return rules.tiebreakTargetPoints || 7;
}

function matchTiebreakTarget(rules: MatchRules): number {
  return rules.matchTiebreakPoints || 10;
}

/** Whether the next set is a match tie-break, from the sets each side has won so far. */
function isMatchTiebreakAt(rules: MatchRules, setsA: number, setsB: number): boolean {
  const need = rules.setsToWinMatch;
  return Boolean(rules.matchTiebreak) && need > 1 && setsA === need - 1 && setsB === need - 1;
}

/**
 * The kind of set that comes after `prior` (sets already entered), so a form can
 * show a games pair or a single tie-break pair. Unreadable prior sets count by
 * their larger number.
 */
export function setKindAt(rules: MatchRules, prior: EnteredSet[]): SetKind {
  let setsA = 0;
  let setsB = 0;
  for (const s of prior) {
    if (s.a > s.b) setsA += 1;
    else if (s.b > s.a) setsB += 1;
  }
  return isMatchTiebreakAt(rules, setsA, setsB) ? "match_tiebreak" : "set";
}

/** A match tie-break as entered: [10-8] → { a: 1, b: 0, tb: { a: 10, b: 8 } }. */
export function matchTiebreakSet(pointsA: number, pointsB: number): EnteredSet {
  return { a: pointsA > pointsB ? 1 : 0, b: pointsB > pointsA ? 1 : 0, tb: { a: pointsA, b: pointsB } };
}

/**
 * The full tie-break score from the loser's points, as scores are written
 * (7-6(5) → 7-5; 7-6(9) → 11-9). For a match tie-break pass `kind: "match_tiebreak"`.
 */
export function completeTiebreak(
  rules: MatchRules,
  winner: TeamKey,
  loserPoints: number,
  kind: SetKind = "set",
): { a: number; b: number } {
  const target = kind === "match_tiebreak" ? matchTiebreakTarget(rules) : setTarget(rules);
  const winByTwo = kind === "match_tiebreak" || rules.tiebreakWinByTwo !== false;
  const won = winByTwo ? Math.max(target, loserPoints + 2) : target;
  return winner === "A" ? { a: won, b: loserPoints } : { a: loserPoints, b: won };
}

/** Whether (w, l) with w > l is a finished tie-break to `target`, and not one that was already over a point earlier. */
function tiebreakFinal(w: number, l: number, target: number, winByTwo: boolean): boolean {
  if (w < target) return false;
  if (!winByTwo) return w === target && l < target;
  return w - l >= 2 && (w === target || w - l === 2);
}

/** The set score kind the rules allow, or null when (w, l) with w > l cannot end a normal set. */
function normalSetEnding(rules: MatchRules, w: number, l: number): "tiebreak" | "games" | null {
  const g = rules.gamesToWinSet;
  const t = rules.tiebreakAtGames;
  if (rules.tiebreakEnabled && w === t + 1 && l === t) return "tiebreak";
  // Won by games: reached the set's games with a two-game margin, and not a game later than that.
  // With a tie-break, the set cannot pass t-t without playing it.
  const byGames = w >= g && w - l >= 2 && (w === g || w - l === 2);
  if (byGames && (!rules.tiebreakEnabled || l < t)) return "games";
  return null;
}

function label(i: number): string {
  return `Set ${i + 1}`;
}

/**
 * Everything wrong with an entered result under the match's rules; empty when it
 * is a finished match the rules can produce.
 */
export function validateFinalScore(rules: MatchRules, sets: EnteredSet[]): FinalScoreProblem[] {
  const ruleProblems = validateMatchRules(rules);
  if (ruleProblems.length > 0) {
    return ruleProblems.map((p) => ({ code: "rules" as const, set: null, message: p.message }));
  }
  if (!Array.isArray(sets) || sets.length === 0) {
    return [{ code: "no_sets", set: null, message: "Enter the score of at least one set." }];
  }

  const problems: FinalScoreProblem[] = [];
  let setsA = 0;
  let setsB = 0;
  let overAt: number | null = null;

  sets.forEach((s, i) => {
    if (overAt !== null) {
      problems.push({ code: "after_match_over", set: i, message: `${label(i)}: the match was already won in set ${overAt + 1}.` });
      return;
    }
    if (!s || !whole(s.a) || !whole(s.b)) {
      problems.push({ code: "not_whole_number", set: i, message: `${label(i)}: games must be whole numbers.` });
      return;
    }
    const tb = s.tb ?? null;
    if (tb && (!whole(tb.a) || !whole(tb.b))) {
      problems.push({ code: "not_whole_number", set: i, message: `${label(i)}: tie-break points must be whole numbers.` });
      return;
    }
    if (s.a === s.b) {
      problems.push({ code: "set_score", set: i, message: `${label(i)}: ${s.a}-${s.b} has no winner.` });
      return;
    }
    const winner: TeamKey = s.a > s.b ? "A" : "B";
    const w = Math.max(s.a, s.b);
    const l = Math.min(s.a, s.b);

    if (isMatchTiebreakAt(rules, setsA, setsB)) {
      const target = matchTiebreakTarget(rules);
      if (w !== 1 || l !== 0) {
        problems.push({
          code: "set_score",
          set: i,
          message: `${label(i)} is a match tie-break to ${target}: enter its points, recorded as 1-0 to the winner.`,
        });
        return;
      }
      if (!tb) {
        problems.push({ code: "tiebreak_required", set: i, message: `${label(i)}: enter the match tie-break points.` });
        return;
      }
      const tw = winner === "A" ? tb.a : tb.b;
      const tl = winner === "A" ? tb.b : tb.a;
      if (tw <= tl || !tiebreakFinal(tw, tl, target, true)) {
        problems.push({
          code: "tiebreak_score",
          set: i,
          message: `${label(i)}: [${tb.a}-${tb.b}] is not a finished match tie-break to ${target} (win by two) won by the set's winner.`,
        });
        return;
      }
    } else {
      const ending = normalSetEnding(rules, w, l);
      if (!ending) {
        problems.push({ code: "set_score", set: i, message: `${label(i)}: ${s.a}-${s.b} cannot finish a set under these rules.` });
        return;
      }
      if (ending === "tiebreak") {
        if (!tb) {
          problems.push({ code: "tiebreak_required", set: i, message: `${label(i)}: enter the tie-break points for ${s.a}-${s.b}.` });
          return;
        }
        const target = setTarget(rules);
        const winByTwo = rules.tiebreakWinByTwo !== false;
        const tw = winner === "A" ? tb.a : tb.b;
        const tl = winner === "A" ? tb.b : tb.a;
        if (tw <= tl || !tiebreakFinal(tw, tl, target, winByTwo)) {
          problems.push({
            code: "tiebreak_score",
            set: i,
            message: `${label(i)}: ${tb.a}-${tb.b} is not a finished tie-break to ${target}${winByTwo ? " (win by two)" : ""} won by the set's winner.`,
          });
          return;
        }
      } else if (tb) {
        problems.push({ code: "tiebreak_not_allowed", set: i, message: `${label(i)}: ${s.a}-${s.b} did not end in a tie-break.` });
        return;
      }
    }

    if (winner === "A") setsA += 1;
    else setsB += 1;
    if (setsA >= rules.setsToWinMatch || setsB >= rules.setsToWinMatch) overAt = i;
  });

  if (problems.length === 0 && overAt === null) {
    const need = rules.setsToWinMatch;
    problems.push({
      code: "unfinished",
      set: null,
      message: `Nobody has won ${need === 1 ? "the set" : `${need} sets`} yet: enter the rest of the match.`,
    });
  }
  return problems;
}

/**
 * The order the points of a finished tally are played in: the loser first and
 * alternating, so the score stays within one until the winner pulls away at the
 * end. That path never finishes a game, set or tie-break early.
 */
function closeOrder(winner: TeamKey, w: number, l: number): TeamKey[] {
  const loser: TeamKey = winner === "A" ? "B" : "A";
  const out: TeamKey[] = [];
  let won = 0;
  let lost = 0;
  while (won < w - 1 || lost < l) {
    if (lost < l && lost <= won) {
      out.push(loser);
      lost += 1;
    } else {
      out.push(winner);
      won += 1;
    }
  }
  out.push(winner);
  return out;
}

export type FinalScoreBuild = { ok: true; state: ScoreState } | { ok: false; problems: FinalScoreProblem[] };

/**
 * The final engine state for an entered result. Validates first; the returned
 * state is over, with `completedSets` equal to what was entered and serve and
 * set bookkeeping exactly as the engine keeps it.
 */
export function stateFromFinalScore(
  rules: MatchRules,
  sets: EnteredSet[],
  opts: { firstServer?: TeamKey } = {},
): FinalScoreBuild {
  const problems = validateFinalScore(rules, sets);
  if (problems.length > 0) return { ok: false, problems };

  let state = initialScoreState(opts.firstServer ?? "A");
  const expected: CompletedSet[] = [];
  for (const s of sets) {
    const winner: TeamKey = s.a > s.b ? "A" : "B";
    expected.push(setOf(s, Boolean(state.isMatchTiebreak)));
    if (state.isMatchTiebreak) {
      const tb = s.tb!;
      const tw = winner === "A" ? tb.a : tb.b;
      const tl = winner === "A" ? tb.b : tb.a;
      for (const team of closeOrder(winner, tw, tl)) state = awardPoint(state, team, rules);
      continue;
    }
    const w = Math.max(s.a, s.b);
    const l = Math.min(s.a, s.b);
    if (s.tb) {
      // Games to the tie-break (t-t), then the tie-break point by point.
      const loser: TeamKey = winner === "A" ? "B" : "A";
      for (let k = 0; k < l; k++) {
        state = awardGame(state, loser, rules);
        state = awardGame(state, winner, rules);
      }
      // l = w - 1 = the tie-break trigger, so the engine is in the tie-break now.
      const tw = winner === "A" ? s.tb.a : s.tb.b;
      const tl = winner === "A" ? s.tb.b : s.tb.a;
      for (const team of closeOrder(winner, tw, tl)) state = awardPoint(state, team, rules);
    } else {
      for (const team of closeOrder(winner, w, l)) state = awardGame(state, team, rules);
    }
  }

  if (!state.matchOver || JSON.stringify(state.completedSets) !== JSON.stringify(expected)) {
    return { ok: false, problems: [{ code: "unreachable", set: null, message: "The engine could not reach this score." }] };
  }
  return { ok: true, state };
}

/** An entered set as the engine records it in `completedSets`. */
function setOf(s: EnteredSet, matchTiebreak: boolean): CompletedSet {
  const set: CompletedSet = { teamAGames: s.a, teamBGames: s.b };
  if (s.tb) set.tiebreak = { a: s.tb.a, b: s.tb.b };
  if (matchTiebreak) set.matchTiebreak = true;
  return set;
}

/**
 * The entered form of a state's completed sets: what a correction form starts
 * from for a finished match, and the inverse of stateFromFinalScore.
 */
export function enteredSetsFromState(state: Pick<ScoreState, "completedSets">): EnteredSet[] {
  return state.completedSets.map((c) => {
    const s: EnteredSet = { a: c.teamAGames, b: c.teamBGames };
    if (c.tiebreak) s.tb = { a: c.tiebreak.a, b: c.tiebreak.b };
    return s;
  });
}

export interface FinalScoreSummary {
  winner: TeamKey | null;
  /** Sets won, side A first. */
  setsWon: { a: number; b: number };
  /** Side A first, as the engine formats sets: "6-4 6-7(5) [10-8]". */
  sets: string;
  /** The same sets with the winner's games first, as a result is read out ("6-4 7-6(5)"). */
  setsWinnerFirst: string;
}

/** The summary the confirmation step shows, with the winner highlighted. */
export function finalScoreSummary(state: Pick<ScoreState, "completedSets" | "winner">): FinalScoreSummary {
  let a = 0;
  let b = 0;
  for (const s of state.completedSets) {
    // A match tie-break is recorded 1-0 to its winner, so games decide every set.
    if (s.teamAGames > s.teamBGames) a += 1;
    else b += 1;
  }
  const flipped = state.winner === "B";
  const winnerFirst = state.completedSets.map((s) =>
    flipped
      ? formatSet({
          teamAGames: s.teamBGames,
          teamBGames: s.teamAGames,
          ...(s.tiebreak ? { tiebreak: { a: s.tiebreak.b, b: s.tiebreak.a } } : {}),
          ...(s.matchTiebreak ? { matchTiebreak: true } : {}),
        })
      : formatSet(s),
  );
  return {
    winner: state.winner,
    setsWon: { a, b },
    sets: state.completedSets.map((s) => formatSet(s)).join(" "),
    setsWinnerFirst: winnerFirst.join(" "),
  };
}
