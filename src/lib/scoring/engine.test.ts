import { describe, it, expect } from "vitest";
import {
  awardPoint,
  initialScoreState,
  manualEndSet,
  pointOutcome,
  scoreSummary,
  totalGames,
  type ScoreState,
  type TeamKey,
} from "./engine";
import { DEFAULT_SCORING_CONFIG } from "../types";

const cfg = DEFAULT_SCORING_CONFIG;

function score(state: ScoreState, team: TeamKey, times: number): ScoreState {
  let s = state;
  for (let i = 0; i < times; i++) s = awardPoint(s, team, cfg);
  return s;
}

function winGames(state: ScoreState, team: TeamKey, games: number): ScoreState {
  let s = state;
  for (let i = 0; i < games; i++) s = score(s, team, 4);
  return s;
}

/** One game to love, under the given rules. */
function winOneGame(state: ScoreState, team: TeamKey, config: typeof cfg): ScoreState {
  let s = state;
  for (let i = 0; i < 4; i++) s = awardPoint(s, team, config);
  return s;
}

describe("point progression", () => {
  it("progresses 0 → 15 → 30 → 40", () => {
    let s = initialScoreState();
    s = awardPoint(s, "A", cfg);
    expect(s.teamA.points).toBe("15");
    s = awardPoint(s, "A", cfg);
    expect(s.teamA.points).toBe("30");
    s = awardPoint(s, "A", cfg);
    expect(s.teamA.points).toBe("40");
  });

  it("wins game from 40 when opponent below 40", () => {
    let s = score(initialScoreState(), "A", 3);
    s = awardPoint(s, "A", cfg);
    expect(s.teamA.games).toBe(1);
    expect(s.teamA.points).toBe("0");
    expect(s.teamB.points).toBe("0");
  });
});

describe("advantage scoring", () => {
  function deuce(): ScoreState {
    const s = score(initialScoreState(), "A", 3);
    return score(s, "B", 3);
  }

  it("40-40 gives advantage", () => {
    const s = awardPoint(deuce(), "A", cfg);
    expect(s.teamA.points).toBe("AD");
  });

  it("advantage + win = game", () => {
    let s = awardPoint(deuce(), "A", cfg);
    s = awardPoint(s, "A", cfg);
    expect(s.teamA.games).toBe(1);
  });

  it("advantage + opponent point = back to deuce", () => {
    let s = awardPoint(deuce(), "A", cfg);
    s = awardPoint(s, "B", cfg);
    expect(s.teamA.points).toBe("40");
    expect(s.teamB.points).toBe("40");
  });
});

describe("set rules", () => {
  it("6-0 wins the set and the match (1 set)", () => {
    const s = winGames(initialScoreState(), "A", 6);
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe("A");
    expect(s.completedSets).toEqual([{ teamAGames: 6, teamBGames: 0 }]);
  });

  it("6-5 does not end the set; 7-5 does", () => {
    let s = winGames(initialScoreState(), "A", 5);
    s = winGames(s, "B", 5);
    s = winGames(s, "A", 1); // 6-5
    expect(s.matchOver).toBe(false);
    s = winGames(s, "A", 1); // 7-5
    expect(s.matchOver).toBe(true);
    expect(s.completedSets[0]).toEqual({ teamAGames: 7, teamBGames: 5 });
  });

  it("6-6 starts a tie-break and hides the server", () => {
    let s = winGames(initialScoreState(), "A", 5);
    s = winGames(s, "B", 5);
    s = winGames(s, "A", 1);
    s = winGames(s, "B", 1); // 6-6
    expect(s.isTiebreak).toBe(true);
    expect(s.servingTeam).toBeNull();
  });
});

describe("tie-break", () => {
  function tiebreakState(): ScoreState {
    let s = winGames(initialScoreState(), "A", 5);
    s = winGames(s, "B", 5);
    s = winGames(s, "A", 1);
    return winGames(s, "B", 1);
  }

  it("first to 7 wins 7-6", () => {
    let s = tiebreakState();
    s = score(s, "A", 7);
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe("A");
    expect(s.completedSets[0]).toEqual({
      teamAGames: 7,
      teamBGames: 6,
      tiebreak: { a: 7, b: 0 },
    });
  });

  it("requires win by two at 6-6 in the tie-break", () => {
    let s = tiebreakState();
    s = score(s, "A", 6);
    s = score(s, "B", 6);
    s = score(s, "A", 1); // 7-6, not enough
    expect(s.matchOver).toBe(false);
    s = score(s, "A", 1); // 8-6
    expect(s.matchOver).toBe(true);
  });
});

describe("serving", () => {
  it("switches server after each game", () => {
    let s = initialScoreState("A");
    s = score(s, "A", 4);
    expect(s.servingTeam).toBe("B");
    s = score(s, "B", 4);
    expect(s.servingTeam).toBe("A");
  });
});

describe("pointOutcome (confirmation detection)", () => {
  it("detects game-winning point", () => {
    const s = score(initialScoreState(), "A", 3);
    expect(pointOutcome(s, "A", cfg).winsGame).toBe(true);
    expect(pointOutcome(s, "B", cfg).winsGame).toBe(false);
  });

  it("detects match-winning point", () => {
    let s = winGames(initialScoreState(), "A", 5);
    s = score(s, "A", 3); // 40-0 at 5-0
    const o = pointOutcome(s, "A", cfg);
    expect(o.winsGame).toBe(true);
    expect(o.winsSet).toBe(true);
    expect(o.winsMatch).toBe(true);
  });
});

describe("manual end set", () => {
  it("awards the set with the current score", () => {
    let s = winGames(initialScoreState(), "A", 4);
    s = winGames(s, "B", 2);
    s = manualEndSet(s, "A", cfg);
    expect(s.matchOver).toBe(true);
    expect(s.completedSets[0]).toEqual({ teamAGames: 4, teamBGames: 2 });
  });
});

describe("totals", () => {
  it("totalGames counts completed sets without double counting", () => {
    const s = winGames(initialScoreState(), "A", 6);
    expect(totalGames(s)).toEqual({ a: 6, b: 0 });
  });

  it("scoreSummary renders in-progress and final scores", () => {
    let s = winGames(initialScoreState(), "A", 3);
    s = winGames(s, "B", 2);
    expect(scoreSummary(s)).toBe("3-2");
    s = winGames(s, "A", 3);
    expect(scoreSummary(s)).toBe("6-2");
  });

  it("an advantage set breaking at 12-12 runs past 6-6", () => {
    // Confirms the rule Phase 1's validation deliberately allows: with the
    // trigger above gamesToWinSet, winGame's two-game margin carries the set on.
    const adv = { ...cfg, gamesToWinSet: 6, tiebreakAtGames: 12 };
    let s = initialScoreState();
    for (let i = 0; i < 7; i++) {
      s = winOneGame(s, "A", adv);
      s = winOneGame(s, "B", adv);
    }
    expect(s.teamA.games).toBe(7);
    expect(s.teamB.games).toBe(7);
    expect(s.isTiebreak).toBe(false);
    expect(s.completedSets).toHaveLength(0);
  });

  it("a trigger below the set length ends the set early — the case validation rejects", () => {
    const bad = { ...cfg, gamesToWinSet: 6, tiebreakAtGames: 3 };
    let s = initialScoreState();
    for (let i = 0; i < 3; i++) {
      s = winOneGame(s, "A", bad);
      s = winOneGame(s, "B", bad);
    }
    expect(s.isTiebreak).toBe(true);
    for (let i = 0; i < 7; i++) s = awardPoint(s, "A", bad);
    // 4-3 in a set the organiser configured as six games.
    expect(s.completedSets[0]).toMatchObject({ teamAGames: 4, teamBGames: 3 });
  });

  it("best-of-3 plays multiple sets", () => {
    const bo3 = { ...cfg, setsToWinMatch: 2 };
    let s = initialScoreState();
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) s = awardPoint(s, "A", bo3);
    expect(s.matchOver).toBe(false);
    expect(s.currentSet).toBe(2);
    expect(s.teamA.games).toBe(0);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) s = awardPoint(s, "A", bo3);
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe("A");
  });
});
