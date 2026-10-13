/**
 * "Match soon": a side is one game from winning the match, so the next match on
 * the court gets ready (Phase 3, decision "Match soon").
 *
 * "One game" is asked of the engine itself: a side is one game from winning when
 * the engine's `awardGame` (the game-penalty step) for that side would end the
 * match. That follows the match's own rules with no second copy of them: a
 * tie-break deciding the match is one game, a match tie-break (super tie-break)
 * is one game, 5-4 in a 6-game deciding set is one game, 5-5 is not.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import type { MatchRules } from "../types";
import { awardGame, type ScoreState, type TeamKey } from "../scoring/engine";

function isGamesState(s: unknown): s is ScoreState {
  const v = s as Partial<ScoreState> | null;
  return !!v && typeof v === "object" && !!v.teamA && !!v.teamB && Array.isArray(v.completedSets);
}

/** The sides one game from winning the match under `rules` (none when over, or not a games-and-sets state). */
export function sidesOneGameFromWinning(rules: MatchRules, state: ScoreState | null | undefined): TeamKey[] {
  if (!isGamesState(state) || state.matchOver) return [];
  return (["A", "B"] as const).filter((team) => {
    const next = awardGame(state, team, rules);
    return next.matchOver && next.winner === team;
  });
}

export function isNearEnd(rules: MatchRules, state: ScoreState | null | undefined): boolean {
  return sidesOneGameFromWinning(rules, state).length > 0;
}

/**
 * Edge trigger: true when the step from `before` to `after` makes the match
 * near its end (some side one game from winning) and it was not before. A
 * match that stays near the end (5-4 → 5-4 30-15, or 5-6 → 6-6 in a deciding
 * tie-break) does not fire again; `before` null is the start of the match.
 *
 * The state alone cannot remember that a match was near its end, went back
 * (5-4 → 5-5) and came near again (6-5), or that an undo crossed the line
 * twice: such a step fires again. "Match soon" is sent once per match, so the
 * caller keeps that fact (e.g. one `match_soon` alert per match id).
 */
export function nearEndCrossed(
  rules: MatchRules,
  before: ScoreState | null | undefined,
  after: ScoreState | null | undefined,
): boolean {
  return !isNearEnd(rules, before) && isNearEnd(rules, after);
}
