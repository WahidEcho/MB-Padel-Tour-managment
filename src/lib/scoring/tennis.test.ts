/**
 * Tennis rules on the shared engine: the real results of the 2024 Junior Billie
 * Jean King Cup final (USA d. Romania 2–1) and two match tie-break results from
 * the same week's placement play-offs, replayed point by point.
 */
import { describe, it, expect } from "vitest";
import {
  awardGame,
  awardPoint,
  currentServer,
  endsChange,
  initialScoreState,
  scoreSummary,
  servingPlayer,
  swapDoublesServer,
  totalGames,
  type ScoreState,
  type TeamKey,
} from "./engine";
import { applyViolation, nextPenalty } from "./conduct";
import { describeMatchRules, isDoublesMatch, scoringConfigForMatch, validateMatchRules } from "./rules";
import { DEFAULT_TENNIS_SCORING_CONFIG, type ScoringConfig } from "../types";

const tennis = { sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG };
const singles = scoringConfigForMatch(tennis, { stage: "group" });
const doubles = scoringConfigForMatch(tennis, { stage: "group" }, null, { doubles: true });

function points(state: ScoreState, team: TeamKey, n: number, cfg: ScoringConfig): ScoreState {
  let s = state;
  for (let i = 0; i < n; i++) s = awardPoint(s, team, cfg);
  return s;
}

/** A game won with the loser taking `against` points first (0–2, so never deuce). */
function game(state: ScoreState, team: TeamKey, cfg: ScoringConfig, against = 1): ScoreState {
  const other: TeamKey = team === "A" ? "B" : "A";
  return points(points(state, other, against, cfg), team, 4, cfg);
}

/**
 * Plays a set to `a`-`b`: the games alternate while both sides still need
 * them, then the winner takes the rest. For a 7-6 set pass the tie-break score.
 */
function set(state: ScoreState, a: number, b: number, cfg: ScoringConfig, tb?: [number, number]): ScoreState {
  let s = state;
  const shared = tb ? 6 : Math.min(a, b);
  for (let i = 0; i < shared; i++) s = game(game(s, "A", cfg), "B", cfg);
  if (tb) return tiebreak(s, tb[0], tb[1], cfg);
  const winner: TeamKey = a > b ? "A" : "B";
  for (let i = shared; i < Math.max(a, b); i++) s = game(s, winner, cfg);
  return s;
}

/** A tie-break (or match tie-break) to the given points, alternating until the end. */
function tiebreak(state: ScoreState, a: number, b: number, cfg: ScoringConfig = doubles): ScoreState {
  let s = state;
  const winner: TeamKey = a > b ? "A" : "B";
  const lo = Math.min(a, b);
  for (let i = 0; i < lo; i++) {
    s = awardPoint(s, "A", cfg);
    s = awardPoint(s, "B", cfg);
  }
  const hi = Math.max(a, b);
  for (let i = lo; i < hi; i++) s = awardPoint(s, winner, cfg);
  return s;
}

describe("tennis defaults", () => {
  it("singles: best of three tie-break sets, advantage scoring", () => {
    expect(singles.setsToWinMatch).toBe(2);
    expect(singles.decidingPoint).toBeUndefined();
    expect(singles.matchTiebreak).toBeUndefined();
    expect(describeMatchRules(singles)).toBe("best of 3 · first to 6 · tie-break to 7 at 6-6");
  });

  it("doubles: deciding point and a match tie-break to 10 at one set all", () => {
    expect(doubles.decidingPoint).toBe(true);
    expect(doubles.matchTiebreak).toBe(true);
    expect(describeMatchRules(doubles)).toBe(
      "best of 3 · first to 6 · tie-break to 7 at 6-6 · match tie-break to 10 at 1 set all · no-ad (deciding point)",
    );
    expect(validateMatchRules(doubles)).toEqual([]);
  });

  it("doubles rules apply only to tennis, and only to doubles", () => {
    const padel = { sport: "padel", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG };
    expect(scoringConfigForMatch(padel, { stage: "group" }, null, { doubles: true }).decidingPoint).toBeUndefined();
    expect(isDoublesMatch({ players: [1] }, { players: [2] })).toBe(false);
    expect(isDoublesMatch({ players: [1, 2] }, { players: [3, 4] })).toBe(true);
  });

  it("a stage override still layers under the doubles rules", () => {
    const t = {
      sport: "tennis",
      scoring_config: { ...DEFAULT_TENNIS_SCORING_CONFIG, stageOverrides: { final: { gamesToWinSet: 6, setsToWinMatch: 3 } } },
    };
    const finalDoubles = scoringConfigForMatch(t, { stage: "final" }, null, { doubles: true });
    expect(finalDoubles.setsToWinMatch).toBe(3);
    expect(finalDoubles.matchTiebreak).toBe(true);
  });
});

describe("the 2024 Junior BJK Cup final, replayed", () => {
  it("Popa d. Pareja 7-5 6-4 (singles, advantage)", () => {
    let s = initialScoreState("A");
    s = set(s, 7, 5, singles);
    expect(s.completedSets).toHaveLength(1);
    s = set(s, 6, 4, singles);
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe("A");
    expect(scoreSummary(s)).toBe("7-5 6-4");
  });

  it("Grant d. Burcescu 6-2 6-1", () => {
    let s = set(initialScoreState("B"), 6, 2, singles);
    s = set(s, 6, 1, singles);
    expect(s.winner).toBe("A");
    expect(scoreSummary(s)).toBe("6-2 6-1");
  });

  it("Grant/Pareja d. Popa/Burcescu 6-1 7-5 (doubles, no match tie-break needed)", () => {
    let s = set(initialScoreState("A"), 6, 1, doubles);
    s = set(s, 7, 5, doubles);
    expect(s.winner).toBe("A");
    expect(s.isMatchTiebreak).toBeUndefined();
    expect(scoreSummary(s)).toBe("6-1 7-5");
  });

  it("a doubles match at one set all goes to a match tie-break: 6-3 6-7(2) [10-5]", () => {
    let s = set(initialScoreState("A"), 6, 3, doubles);
    s = set(s, 6, 7, doubles, [2, 7]);
    expect(s.completedSets[1].tiebreak).toEqual({ a: 2, b: 7 });
    expect(s.isTiebreak).toBe(true);
    expect(s.isMatchTiebreak).toBe(true);
    expect(s.currentSet).toBe(3);
    // Nine points is not enough: first to ten.
    s = tiebreak(s, 9, 5);
    expect(s.matchOver).toBe(false);
    s = awardPoint(s, "A", doubles);
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe("A");
    expect(s.completedSets[2]).toEqual({ teamAGames: 1, teamBGames: 0, tiebreak: { a: 10, b: 5 }, matchTiebreak: true });
    expect(scoreSummary(s)).toBe("6-3 6-7(2) [10-5]");
    // Counts as one game in the standings, the way the ITF records it.
    expect(totalGames(s)).toEqual({ a: 13, b: 10 });
  });

  it("a match tie-break needs two clear points: 11-9", () => {
    let s = set(initialScoreState("A"), 6, 0, doubles);
    s = set(s, 0, 6, doubles);
    s = tiebreak(s, 9, 9);
    s = awardPoint(s, "A", doubles);
    expect(s.matchOver).toBe(false);
    s = awardPoint(s, "A", doubles);
    expect(s.matchOver).toBe(true);
    expect(scoreSummary(s)).toBe("6-0 0-6 [11-9]");
  });

  it("the in-progress match tie-break shows its points", () => {
    let s = set(initialScoreState("A"), 6, 0, doubles);
    s = set(s, 0, 6, doubles);
    s = tiebreak(s, 3, 2);
    expect(scoreSummary(s)).toBe("6-0 0-6 [3-2]");
  });

  it("a singles play-off under a match tie-break override: 6-0 4-6 [10-5]", () => {
    const playoff = scoringConfigForMatch(
      { sport: "tennis", scoring_config: { ...DEFAULT_TENNIS_SCORING_CONFIG, stageOverrides: { bracket: { matchTiebreak: true } } } },
      { stage: "knockout" },
    );
    let s = set(initialScoreState("A"), 6, 0, playoff);
    s = set(s, 4, 6, playoff);
    expect(s.isMatchTiebreak).toBe(true);
    for (let i = 0; i < 5; i++) s = awardPoint(awardPoint(s, "A", playoff), "B", playoff);
    for (let i = 0; i < 5; i++) s = awardPoint(s, "A", playoff);
    expect(s.winner).toBe("A");
    expect(scoreSummary(s)).toBe("6-0 4-6 [10-5]");
  });
});

describe("deciding point", () => {
  it("at 40-40 the next point wins the game under no-ad", () => {
    let s = points(initialScoreState("A"), "A", 3, doubles);
    s = points(s, "B", 3, doubles);
    expect([s.teamA.points, s.teamB.points]).toEqual(["40", "40"]);
    s = awardPoint(s, "B", doubles);
    expect(s.teamB.games).toBe(1);
    expect(s.teamA.points).toBe("0");
  });

  it("advantage scoring is unchanged in singles", () => {
    let s = points(initialScoreState("A"), "A", 3, singles);
    s = points(s, "B", 3, singles);
    s = awardPoint(s, "B", singles);
    expect(s.teamB.points).toBe("AD");
    expect(s.teamB.games).toBe(0);
  });
});

describe("serve", () => {
  it("the tie-break's first server receives first in the next set", () => {
    const s = set(initialScoreState("A"), 6, 7, singles, [5, 7]);
    // A served games 1,3,…,11, so B served game 12's slot → A serves the tie-break first.
    expect(s.servingTeam).toBe("B");
    expect(s.setFirstServer).toBe("B");
  });

  it("the match tie-break starts with the team due to serve", () => {
    let s = set(initialScoreState("A"), 6, 4, doubles);
    s = set(s, 4, 6, doubles);
    expect(currentServer(s)).toBe(s.tiebreakFirstServer);
    expect(s.servingTeam).toBeNull();
  });

  it("doubles service rotates A1, B1, A2, B2", () => {
    let s = initialScoreState("A");
    const seq: string[] = [];
    for (let g = 0; g < 5; g++) {
      const p = servingPlayer(s)!;
      seq.push(`${p.team}${p.index + 1}`);
      s = game(s, g % 2 === 0 ? "A" : "B", doubles);
    }
    expect(seq).toEqual(["A1", "B1", "A2", "B2", "A1"]);
  });

  it("the referee can swap a team's order; the rotation follows", () => {
    let s = swapDoublesServer(initialScoreState("A"), "A");
    expect(servingPlayer(s)).toEqual({ team: "A", index: 1 });
    s = game(s, "A", doubles);
    s = game(s, "B", doubles);
    expect(servingPlayer(s)).toEqual({ team: "A", index: 0 });
  });

  it("the tie-break continues the doubles rotation, a turn per two points", () => {
    let s = set(initialScoreState("A"), 6, 6, singles);
    // 12 games: A1 B1 A2 B2 … so turn 12 is A1 again.
    const at = () => {
      const p = servingPlayer(s)!;
      return `${p.team}${p.index + 1}`;
    };
    expect(s.isTiebreak).toBe(true);
    expect(at()).toBe("A1");
    s = awardPoint(s, "A", singles);
    expect(at()).toBe("B1");
    s = awardPoint(s, "A", singles);
    expect(at()).toBe("B1");
    s = awardPoint(s, "A", singles);
    expect(at()).toBe("A2");
  });
});

describe("change of ends", () => {
  it("after games 1, 3, 5 of a set; no rest after the first", () => {
    let s = initialScoreState("A");
    const calls: string[] = [];
    for (let g = 0; g < 5; g++) {
      const next = game(s, "A", singles);
      const c = endsChange(s, next);
      calls.push(c.changeEnds ? `${c.kind}:${c.restSeconds}` : "-");
      s = next;
    }
    expect(calls).toEqual(["changeover:0", "-", "changeover:90", "-", "changeover:90"]);
  });

  it("a set break of 120 seconds, changing ends only after an odd set", () => {
    const before = set(initialScoreState("A"), 5, 3, singles);
    const after = game(before, "A", singles); // 6-3: nine games
    expect(endsChange(before, after)).toEqual({ changeEnds: true, restSeconds: 120, kind: "set_break" });
    const even = set(initialScoreState("A"), 5, 2, singles); // 6-2: eight games
    expect(endsChange(even, game(even, "A", singles))).toEqual({ changeEnds: false, restSeconds: 120, kind: "set_break" });
  });

  it("every six points in a tie-break, without rest", () => {
    let s = set(initialScoreState("A"), 6, 6, singles);
    const changes: number[] = [];
    for (let p = 1; p <= 12; p++) {
      const next = awardPoint(s, p % 2 ? "A" : "B", singles);
      if (endsChange(s, next).changeEnds) changes.push(p);
      s = next;
    }
    expect(changes).toEqual([6, 12]);
  });

  it("nothing once the match is over", () => {
    const s = set(set(initialScoreState("A"), 6, 0, singles), 5, 0, singles);
    const done = game(s, "A", singles);
    expect(done.matchOver).toBe(true);
    expect(endsChange(s, done).changeEnds).toBe(false);
  });
});

describe("code violations", () => {
  it("warning, point penalty, then game penalties", () => {
    let s = initialScoreState("A");
    const ladder: string[] = [];
    for (let i = 0; i < 3; i++) {
      const penalty = nextPenalty(s, "A", "racket_abuse", true);
      ladder.push(penalty);
      s = applyViolation(s, { team: "A", offence: "racket_abuse", penalty }, singles);
    }
    expect(ladder).toEqual(["warning", "point", "game"]);
    // The point went to B (15), then the game penalty gave B the game.
    expect(s.teamB.games).toBe(1);
    expect(s.teamA.points).toBe("0");
    expect(s.violations).toHaveLength(3);
  });

  it("time violations have their own ladder: warning, then point or fault", () => {
    let s = initialScoreState("A");
    expect(nextPenalty(s, "B", "time", false)).toBe("warning");
    s = applyViolation(s, { team: "B", offence: "time", penalty: "warning" }, singles);
    expect(nextPenalty(s, "B", "time", false)).toBe("point");
    expect(nextPenalty(s, "B", "time", true)).toBe("fault");
    // A code violation still starts at a warning.
    expect(nextPenalty(s, "B", "coaching", false)).toBe("warning");
  });

  it("a warning changes no score, and the state is a copy", () => {
    const s = initialScoreState("A");
    const next = applyViolation(s, { team: "A", offence: "coaching", penalty: "warning" }, singles);
    expect(next).not.toBe(s);
    expect(s.violations).toBeUndefined();
    expect(next.teamB.points).toBe("0");
  });

  it("a game penalty in a tie-break decides the set", () => {
    const s = set(initialScoreState("A"), 6, 6, singles);
    const next = awardGame(s, "B", singles);
    expect(next.completedSets[0]).toMatchObject({ teamAGames: 6, teamBGames: 7 });
    expect(next.isTiebreak).toBe(false);
  });
});

describe("the voice umpire on tennis rules", () => {
  it("calls a doubles match through to a match tie-break without a gap", async () => {
    const { pointCall } = await import("../voice/calls");
    let s = set(initialScoreState("A"), 6, 3, doubles);
    s = set(s, 3, 5, doubles);
    const before = s;
    s = game(s, "B", doubles); // 3-6: one set all
    expect(pointCall(before, s, doubles)?.slice(0, 1)).toEqual(["game-and-set"]);
    expect(s.isMatchTiebreak).toBe(true);
    let silent = 0;
    while (!s.matchOver) {
      const next = awardPoint(s, "A", doubles);
      if (!pointCall(s, next, doubles)) silent++;
      s = next;
    }
    expect(silent).toBe(0);
    expect(pointCall(s, s, doubles)).toEqual(["game-set-match"]);
  });

  it("the deciding point is called like any game-winning point", async () => {
    const { pointCall } = await import("../voice/calls");
    let s = points(initialScoreState("A"), "A", 3, doubles);
    s = points(s, "B", 3, doubles);
    const won = awardPoint(s, "A", doubles);
    expect(pointCall(s, won, doubles)?.[0]).toBe("game");
  });
});
