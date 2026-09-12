/**
 * Fire-streak engine for friendly sessions.
 *
 * Locked rules (DECISIONS.md — do not change without updating that file):
 *  - A win is worth 3 base points; a loss is worth 0.
 *  - Fire points reward consecutive wins: win 1 of a streak earns nothing,
 *    wins 2..11 earn +1 each, so an uninterrupted 11-win streak banks +10.
 *    Wins 12+ earn nothing further until the streak breaks.
 *  - A played loss resets the active streak to 0. Fire points already banked
 *    are never removed. A later streak can bank another 10.
 *  - The streak carries across sessions and seasons — it is a property of the
 *    player, not of a session.
 *  - A walkover WIN pays the 3 base points but leaves the streak FROZEN: it
 *    neither advances nor resets, so the next played win continues from where
 *    the player was. A walkover LOSS (the absent player) resets the streak.
 *  - A void/cancelled match has no effect on points or streak.
 *
 * This module is pure: no database, no framework. Fire history is always
 * rebuildable from an ordered list of results via `rebuildFromResults`, which
 * is what corrections and profile merges use.
 */

/** How a finished match counted for one particular player. */
export type FriendlyResultKind = "win" | "loss" | "walkover_win" | "walkover_loss" | "void";

export interface FireState {
  /** Length of the currently active winning streak. */
  consecutiveWins: number;
  /** Fire points banked over all time. Never decreases. */
  totalFirePoints: number;
}

/** Base points awarded to each player on the winning pair. */
export const BASE_WIN_POINTS = 3;
/** The last win of a streak that still earns a fire point. */
export const FIRE_STREAK_CAP = 11;
/** Maximum fire points a single uninterrupted streak can bank. */
export const MAX_FIRE_PER_STREAK = FIRE_STREAK_CAP - 1;

export function initialFireState(): FireState {
  return { consecutiveWins: 0, totalFirePoints: 0 };
}

export interface FireAward {
  /** The player's state after this result. */
  state: FireState;
  /** Base points earned by this result (3 for any win, else 0). */
  basePoints: number;
  /** Fire points earned by this result (0 or 1). */
  firePoints: number;
}

/**
 * Apply one result to a player's fire state.
 * Pure — `prev` is never mutated.
 */
export function applyResult(prev: FireState, kind: FriendlyResultKind): FireAward {
  switch (kind) {
    case "void":
      return { state: { ...prev }, basePoints: 0, firePoints: 0 };

    case "loss":
      return {
        state: { consecutiveWins: 0, totalFirePoints: prev.totalFirePoints },
        basePoints: 0,
        firePoints: 0,
      };

    case "walkover_loss":
      // The absent player's streak breaks even though no match was played.
      return {
        state: { consecutiveWins: 0, totalFirePoints: prev.totalFirePoints },
        basePoints: 0,
        firePoints: 0,
      };

    case "walkover_win":
      // Base points only; the streak is frozen, not advanced.
      return { state: { ...prev }, basePoints: BASE_WIN_POINTS, firePoints: 0 };

    case "win": {
      const consecutiveWins = prev.consecutiveWins + 1;
      const firePoints = consecutiveWins >= 2 && consecutiveWins <= FIRE_STREAK_CAP ? 1 : 0;
      return {
        state: {
          consecutiveWins,
          totalFirePoints: prev.totalFirePoints + firePoints,
        },
        basePoints: BASE_WIN_POINTS,
        firePoints,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Predicate helpers — for confirmation UI before a state-changing act */
/* ------------------------------------------------------------------ */

/** Would this result earn the player a fire point? */
export function wouldEarnFirePoint(prev: FireState, kind: FriendlyResultKind): boolean {
  return applyResult(prev, kind).firePoints > 0;
}

/** Would this result break an active streak the player currently has? */
export function wouldResetStreak(prev: FireState, kind: FriendlyResultKind): boolean {
  if (prev.consecutiveWins === 0) return false;
  return applyResult(prev, kind).state.consecutiveWins === 0;
}

/** Is this the win that reaches the per-streak fire cap (the 11th)? */
export function wouldCompleteStreakCap(prev: FireState, kind: FriendlyResultKind): boolean {
  return kind === "win" && prev.consecutiveWins + 1 === FIRE_STREAK_CAP;
}

/* ------------------------------------------------------------------ */
/* Replay — corrections, late-syncing results, and profile merges       */
/* ------------------------------------------------------------------ */

export interface FireResultInput {
  /** Stable identifier for the result being replayed (usually the match id). */
  matchId: string;
  kind: FriendlyResultKind;
}

export interface ReplayedAward extends FireResultInput {
  basePoints: number;
  firePoints: number;
  /** Streak length after this result — useful for auditing a rebuild. */
  consecutiveWinsAfter: number;
}

export interface FireReplay {
  /** Final state after replaying every result. */
  state: FireState;
  /** One entry per input, in the same order. */
  awards: ReplayedAward[];
}

/**
 * Recompute a player's entire fire history from an ordered result list.
 *
 * Callers MUST pass results in the authoritative order — ascending
 * `player_score_ledger.id` (server-assigned), never a client timestamp, since
 * offline devices sync late and their clocks drift. Corrections, late syncs,
 * and profile merges all funnel through here so the result is identical
 * regardless of which path triggered the rebuild.
 */
export function rebuildFromResults(results: FireResultInput[]): FireReplay {
  let state = initialFireState();
  const awards: ReplayedAward[] = [];
  for (const r of results) {
    const award = applyResult(state, r.kind);
    state = award.state;
    awards.push({
      matchId: r.matchId,
      kind: r.kind,
      basePoints: award.basePoints,
      firePoints: award.firePoints,
      consecutiveWinsAfter: state.consecutiveWins,
    });
  }
  return { state, awards };
}

/** Total points (base + fire) contributed by a set of replayed awards. */
export function totalPoints(awards: ReplayedAward[]): number {
  return awards.reduce((sum, a) => sum + a.basePoints + a.firePoints, 0);
}

/**
 * Derive the per-player result kind from a finished match.
 * `status` uses the existing MatchStatus vocabulary so friendly matches share
 * the tournament finalization path.
 */
export function resultKindFor(
  status: string,
  playerWon: boolean
): FriendlyResultKind {
  switch (status) {
    case "completed":
    case "retired":
      // A retirement still produces a played result for both sides.
      return playerWon ? "win" : "loss";
    case "walkover":
    case "disqualified":
      return playerWon ? "walkover_win" : "walkover_loss";
    case "cancelled":
      return "void";
    default:
      return "void";
  }
}
