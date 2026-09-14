import type { CompletedSet, ScoringConfig } from "../types";

export type PointLabel = "0" | "15" | "30" | "40" | "AD";
export type TeamKey = "A" | "B";

export interface TeamScore {
  points: PointLabel;
  games: number;
  sets: number;
  tiebreakPoints: number;
}

export interface ScoreState {
  currentSet: number;
  teamA: TeamScore;
  teamB: TeamScore;
  isTiebreak: boolean;
  completedSets: CompletedSet[];
  // 'A' | 'B' | null. Null during a tie-break, where service rotates every two
  // points: the venue screens draw their serve dot from this field, so it stays
  // null there and `currentServer` answers who is serving instead.
  servingTeam: TeamKey | null;
  /**
   * Who served the first point of the tie-break in progress. Captured when the
   * tie-break starts; absent on states saved before it existed, in which case the
   * tie-break server is unknown rather than guessed.
   */
  tiebreakFirstServer?: TeamKey | null;
  winner: TeamKey | null;
  matchOver: boolean;
}

export function opponent(team: TeamKey): TeamKey {
  return team === "A" ? "B" : "A";
}

export function initialScoreState(firstServer: TeamKey = "A"): ScoreState {
  return {
    currentSet: 1,
    teamA: { points: "0", games: 0, sets: 0, tiebreakPoints: 0 },
    teamB: { points: "0", games: 0, sets: 0, tiebreakPoints: 0 },
    isTiebreak: false,
    completedSets: [],
    servingTeam: firstServer,
    winner: null,
    matchOver: false,
  };
}

function teamScore(state: ScoreState, team: TeamKey): TeamScore {
  return team === "A" ? state.teamA : state.teamB;
}

const NEXT_POINT: Record<string, PointLabel> = { "0": "15", "15": "30", "30": "40" };

function clone(state: ScoreState): ScoreState {
  return JSON.parse(JSON.stringify(state)) as ScoreState;
}

export function awardPoint(prev: ScoreState, scoringTeam: TeamKey, config: ScoringConfig): ScoreState {
  if (prev.matchOver) return prev;
  const state = clone(prev);
  if (state.isTiebreak) return awardTiebreakPoint(state, scoringTeam, config);
  return awardNormalPoint(state, scoringTeam, config);
}

function awardNormalPoint(state: ScoreState, scoringTeam: TeamKey, config: ScoringConfig): ScoreState {
  const scorer = teamScore(state, scoringTeam);
  const other = teamScore(state, opponent(scoringTeam));

  // Advantage wins the game
  if (scorer.points === "AD") return winGame(state, scoringTeam, config);

  // Opponent had advantage → back to deuce
  if (other.points === "AD") {
    other.points = "40";
    scorer.points = "40";
    return state;
  }

  // Deuce → advantage
  if (scorer.points === "40" && other.points === "40") {
    scorer.points = "AD";
    return state;
  }

  // 40 with opponent below 40 → game
  if (scorer.points === "40") return winGame(state, scoringTeam, config);

  scorer.points = NEXT_POINT[scorer.points];
  return state;
}

function winGame(state: ScoreState, winningTeam: TeamKey, config: ScoringConfig): ScoreState {
  teamScore(state, winningTeam).games += 1;
  state.teamA.points = "0";
  state.teamB.points = "0";

  // Serve switches after every game
  if (state.servingTeam) state.servingTeam = opponent(state.servingTeam);

  if (
    config.tiebreakEnabled &&
    state.teamA.games === config.tiebreakAtGames &&
    state.teamB.games === config.tiebreakAtGames
  ) {
    state.isTiebreak = true;
    // The team due to serve the next game serves the tie-break's first point.
    state.tiebreakFirstServer = state.servingTeam;
    state.servingTeam = null;
    return state;
  }

  const won = teamScore(state, winningTeam).games;
  const lost = teamScore(state, opponent(winningTeam)).games;
  if (won >= config.gamesToWinSet && won - lost >= 2) {
    return winSet(state, winningTeam, config);
  }
  return state;
}

function awardTiebreakPoint(state: ScoreState, scoringTeam: TeamKey, config: ScoringConfig): ScoreState {
  teamScore(state, scoringTeam).tiebreakPoints += 1;
  const scorerPts = teamScore(state, scoringTeam).tiebreakPoints;
  const otherPts = teamScore(state, opponent(scoringTeam)).tiebreakPoints;
  const target = config.tiebreakTargetPoints || 7;
  const winByTwo = config.tiebreakWinByTwo !== false;

  if (scorerPts >= target && (!winByTwo || scorerPts - otherPts >= 2)) {
    teamScore(state, scoringTeam).games += 1; // 7-6
    return winSet(state, scoringTeam, config);
  }
  return state;
}

function winSet(state: ScoreState, winningTeam: TeamKey, config: ScoringConfig): ScoreState {
  const tiebreakFirstServer = state.isTiebreak ? state.tiebreakFirstServer ?? null : null;
  teamScore(state, winningTeam).sets += 1;
  const set: CompletedSet = { teamAGames: state.teamA.games, teamBGames: state.teamB.games };
  if (state.isTiebreak) {
    set.tiebreak = { a: state.teamA.tiebreakPoints, b: state.teamB.tiebreakPoints };
  }
  state.completedSets.push(set);

  if (teamScore(state, winningTeam).sets >= config.setsToWinMatch) {
    state.winner = winningTeam;
    state.matchOver = true;
    return state;
  }

  // Next set
  state.currentSet += 1;
  state.teamA = { ...state.teamA, points: "0", games: 0, tiebreakPoints: 0 };
  state.teamB = { ...state.teamB, points: "0", games: 0, tiebreakPoints: 0 };
  state.isTiebreak = false;
  // The team that served first in a tie-break receives first in the next set.
  if (tiebreakFirstServer) state.servingTeam = opponent(tiebreakFirstServer);
  else if (!state.servingTeam) state.servingTeam = "A";
  delete state.tiebreakFirstServer;
  return state;
}

/** Manually end the current set, awarding it to `winningTeam` with the score as-is (spec §12.10). */
export function manualEndSet(prev: ScoreState, winningTeam: TeamKey, config: ScoringConfig): ScoreState {
  if (prev.matchOver) return prev;
  const state = clone(prev);
  return winSet(state, winningTeam, config);
}

export interface PointOutcome {
  winsGame: boolean;
  winsSet: boolean;
  winsMatch: boolean;
}

/** What would happen if `team` scores the next point — used for confirmation dialogs (spec §12.6). */
export function pointOutcome(state: ScoreState, team: TeamKey, config: ScoringConfig): PointOutcome {
  const next = awardPoint(state, team, config);
  const before = teamScore(state, team);
  const after = teamScore(next, team);
  const setsBefore = before.sets;
  return {
    winsGame:
      after.games > before.games ||
      after.sets > setsBefore ||
      next.completedSets.length > state.completedSets.length,
    winsSet: after.sets > setsBefore,
    winsMatch: next.matchOver && !state.matchOver,
  };
}

/** Whether the tie-break's next point is served by its first server. */
function tiebreakFirstServes(state: ScoreState): boolean {
  const played = state.teamA.tiebreakPoints + state.teamB.tiebreakPoints;
  // One point, then two each: first, other, other, first, first, other, other…
  return Math.floor((played + 1) / 2) % 2 === 0;
}

/**
 * Who serves the next point. In a normal game that is `servingTeam`; in a
 * tie-break it rotates from `tiebreakFirstServer`. Null once the match is over or
 * when the server is unknown.
 */
export function currentServer(state: ScoreState): TeamKey | null {
  if (state.matchOver) return null;
  if (!state.isTiebreak) return state.servingTeam;
  const first = state.tiebreakFirstServer;
  if (!first) return null;
  return tiebreakFirstServes(state) ? first : opponent(first);
}

export function changeServer(prev: ScoreState, server: TeamKey): ScoreState {
  const state = clone(prev);
  if (!state.isTiebreak) {
    state.servingTeam = server;
    return state;
  }
  // In a tie-break the referee corrects who is serving now; the rotation is kept
  // by re-deriving who must have served first.
  state.tiebreakFirstServer = tiebreakFirstServes(state) ? server : opponent(server);
  return state;
}

/** Total games won across the whole match (completed sets + current in-progress set). */
export function totalGames(state: ScoreState): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const s of state.completedSets) {
    a += s.teamAGames;
    b += s.teamBGames;
  }
  // When the match is over the final set is already in completedSets and
  // teamX.games still holds the same numbers — don't count them twice.
  if (!state.matchOver) {
    a += state.teamA.games;
    b += state.teamB.games;
  }
  return { a, b };
}

export function scoreSummary(state: ScoreState): string {
  const parts = state.completedSets.map((s) => {
    const tb = s.tiebreak ? `(${Math.min(s.tiebreak.a, s.tiebreak.b)})` : "";
    return `${s.teamAGames}-${s.teamBGames}${tb}`;
  });
  if (!state.matchOver) {
    parts.push(`${state.teamA.games}-${state.teamB.games}`);
  }
  return parts.join(" ");
}
