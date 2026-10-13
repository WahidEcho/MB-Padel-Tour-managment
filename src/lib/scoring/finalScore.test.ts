import { describe, expect, it } from "vitest";
import { awardPoint, initialScoreState, scoreSummary, type ScoreState, type TeamKey } from "./engine";
import {
  completeTiebreak,
  enteredSetsFromState,
  finalScoreSummary,
  matchTiebreakSet,
  setKindAt,
  stateFromFinalScore,
  validateFinalScore,
  type EnteredSet,
} from "./finalScore";
import { DEFAULT_SCORING_CONFIG, DEFAULT_TENNIS_SCORING_CONFIG, type MatchRules } from "../types";

const PADEL: MatchRules = DEFAULT_SCORING_CONFIG;
const SINGLES: MatchRules = { ...DEFAULT_TENNIS_SCORING_CONFIG };
const DOUBLES: MatchRules = { ...DEFAULT_TENNIS_SCORING_CONFIG, ...DEFAULT_TENNIS_SCORING_CONFIG.doubles };
const BEST_OF_FIVE_MTB: MatchRules = { ...SINGLES, setsToWinMatch: 3, matchTiebreak: true, matchTiebreakPoints: 10 };
const SHORT_4_TB4: MatchRules = { ...PADEL, setsToWinMatch: 2, gamesToWinSet: 4, tiebreakAtGames: 4, tiebreakTargetPoints: 7 };
const FAST4: MatchRules = { ...PADEL, setsToWinMatch: 2, gamesToWinSet: 4, tiebreakAtGames: 3, tiebreakTargetPoints: 5, tiebreakWinByTwo: false, decidingPoint: true };
const ADVANTAGE: MatchRules = { ...PADEL, setsToWinMatch: 2, tiebreakEnabled: false };
const LONG_SET: MatchRules = { ...PADEL, tiebreakAtGames: 8 };
const PRO_SET: MatchRules = { ...PADEL, gamesToWinSet: 8, tiebreakAtGames: 8, tiebreakTargetPoints: 7 };
const GOLDEN_TB10: MatchRules = { ...PADEL, setsToWinMatch: 2, decidingPoint: true, tiebreakTargetPoints: 10, matchTiebreak: true, matchTiebreakPoints: 7 };

const RULE_SETS: Record<string, MatchRules> = {
  PADEL,
  SINGLES,
  DOUBLES,
  BEST_OF_FIVE_MTB,
  SHORT_4_TB4,
  FAST4,
  ADVANTAGE,
  LONG_SET,
  PRO_SET,
  GOLDEN_TB10,
};

const codes = (rules: MatchRules, sets: EnteredSet[]) => validateFinalScore(rules, sets).map((p) => p.code);

function built(rules: MatchRules, sets: EnteredSet[]): ScoreState {
  const r = stateFromFinalScore(rules, sets);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.state;
}

describe("validateFinalScore", () => {
  it("accepts ordinary finished results", () => {
    expect(codes(PADEL, [{ a: 6, b: 4 }])).toEqual([]);
    expect(codes(PADEL, [{ a: 3, b: 6 }])).toEqual([]);
    expect(codes(SINGLES, [{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 7, b: 5 }])).toEqual([]);
    expect(codes(SINGLES, [{ a: 6, b: 0 }, { a: 6, b: 0 }])).toEqual([]);
  });

  it("requires tie-break points on a 7-6 set and checks them", () => {
    expect(codes(PADEL, [{ a: 7, b: 6 }])).toEqual(["tiebreak_required"]);
    expect(codes(PADEL, [{ a: 7, b: 6, tb: { a: 7, b: 5 } }])).toEqual([]);
    expect(codes(PADEL, [{ a: 7, b: 6, tb: { a: 12, b: 10 } }])).toEqual([]);
    // Over a point earlier, short of the target, not by two, or won by the set's loser.
    expect(codes(PADEL, [{ a: 7, b: 6, tb: { a: 9, b: 5 } }])).toEqual(["tiebreak_score"]);
    expect(codes(PADEL, [{ a: 7, b: 6, tb: { a: 6, b: 4 } }])).toEqual(["tiebreak_score"]);
    expect(codes(PADEL, [{ a: 7, b: 6, tb: { a: 8, b: 7 } }])).toEqual(["tiebreak_score"]);
    expect(codes(PADEL, [{ a: 7, b: 6, tb: { a: 5, b: 7 } }])).toEqual(["tiebreak_score"]);
  });

  it("refuses tie-break points on a set that did not end in one", () => {
    expect(codes(PADEL, [{ a: 6, b: 4, tb: { a: 7, b: 5 } }])).toEqual(["tiebreak_not_allowed"]);
  });

  it("refuses scores no set can end on", () => {
    for (const s of [
      { a: 6, b: 5 }, // one game short of the margin
      { a: 5, b: 3 }, // short of six
      { a: 8, b: 6 }, // passes 6-6 without the tie-break
      { a: 7, b: 3 }, // over a game earlier
      { a: 6, b: 6 },
      { a: 8, b: 7 },
    ]) {
      expect(codes(PADEL, [s])).toEqual(["set_score"]);
    }
    expect(codes(PADEL, [{ a: 6.5, b: 2 }])).toEqual(["not_whole_number"]);
    expect(codes(PADEL, [{ a: -1, b: 6 }])).toEqual(["not_whole_number"]);
    expect(codes(PADEL, [{ a: 7, b: 6, tb: { a: 7.5, b: 5 } }])).toEqual(["not_whole_number"]);
  });

  it("checks the match as a whole", () => {
    expect(codes(PADEL, [])).toEqual(["no_sets"]);
    expect(codes(SINGLES, [{ a: 6, b: 4 }])).toEqual(["unfinished"]);
    expect(codes(SINGLES, [{ a: 6, b: 4 }, { a: 6, b: 4 }, { a: 6, b: 4 }])).toEqual(["after_match_over"]);
    expect(validateFinalScore(SINGLES, [{ a: 6, b: 4 }, { a: 5, b: 3 }])[0]).toMatchObject({ code: "set_score", set: 1 });
  });

  it("reports inconsistent rules instead of judging the score", () => {
    expect(codes({ ...PADEL, tiebreakAtGames: 3 }, [{ a: 6, b: 4 }])).toEqual(["rules"]);
  });

  it("allows long advantage sets without a tie-break", () => {
    expect(codes(ADVANTAGE, [{ a: 6, b: 4 }, { a: 12, b: 10 }])).toEqual([]);
    expect(codes(ADVANTAGE, [{ a: 6, b: 4 }, { a: 7, b: 6 }])).toEqual(["set_score"]);
    expect(codes(ADVANTAGE, [{ a: 6, b: 4 }, { a: 13, b: 10 }])).toEqual(["set_score"]);
    // A tie-break only at 8-8: 8-6 is fine, 9-8 needs points.
    expect(codes(LONG_SET, [{ a: 8, b: 6 }])).toEqual([]);
    expect(codes(LONG_SET, [{ a: 9, b: 8 }])).toEqual(["tiebreak_required"]);
    expect(codes(LONG_SET, [{ a: 9, b: 8, tb: { a: 7, b: 3 } }])).toEqual([]);
    expect(codes(LONG_SET, [{ a: 10, b: 8 }])).toEqual(["set_score"]);
  });

  it("handles short sets and a sudden-death tie-break", () => {
    expect(codes(SHORT_4_TB4, [{ a: 4, b: 2 }, { a: 5, b: 4, tb: { a: 7, b: 2 } }])).toEqual([]);
    expect(codes(SHORT_4_TB4, [{ a: 4, b: 2 }, { a: 5, b: 3 }])).toEqual([]);
    expect(codes(SHORT_4_TB4, [{ a: 4, b: 2 }, { a: 4, b: 3 }])).toEqual(["set_score"]);
    // Fast4: tie-break at 3-3, first to 5, no margin.
    expect(codes(FAST4, [{ a: 4, b: 3, tb: { a: 5, b: 4 } }, { a: 4, b: 1 }])).toEqual([]);
    expect(codes(FAST4, [{ a: 4, b: 3, tb: { a: 6, b: 4 } }, { a: 4, b: 1 }])).toEqual(["tiebreak_score"]);
    expect(codes(FAST4, [{ a: 4, b: 3, tb: { a: 5, b: 5 } }, { a: 4, b: 1 }])).toEqual(["tiebreak_score"]);
    expect(codes(FAST4, [{ a: 5, b: 3 }, { a: 4, b: 1 }])).toEqual(["set_score"]);
    expect(codes(PRO_SET, [{ a: 9, b: 8, tb: { a: 7, b: 4 } }])).toEqual([]);
    expect(codes(PRO_SET, [{ a: 8, b: 6 }])).toEqual([]);
  });

  it("treats the deciding set as a match tie-break when the rules say so", () => {
    const decider = matchTiebreakSet(10, 8);
    expect(decider).toEqual({ a: 1, b: 0, tb: { a: 10, b: 8 } });
    expect(codes(DOUBLES, [{ a: 6, b: 4 }, { a: 4, b: 6 }, decider])).toEqual([]);
    expect(codes(DOUBLES, [{ a: 6, b: 4 }, { a: 4, b: 6 }, matchTiebreakSet(12, 14)])).toEqual([]);
    expect(codes(DOUBLES, [{ a: 6, b: 4 }, { a: 4, b: 6 }, { a: 1, b: 0 }])).toEqual(["tiebreak_required"]);
    expect(codes(DOUBLES, [{ a: 6, b: 4 }, { a: 4, b: 6 }, { a: 6, b: 3 }])).toEqual(["set_score"]);
    expect(codes(DOUBLES, [{ a: 6, b: 4 }, { a: 4, b: 6 }, matchTiebreakSet(10, 9)])).toEqual(["tiebreak_score"]);
    expect(codes(DOUBLES, [{ a: 6, b: 4 }, { a: 4, b: 6 }, matchTiebreakSet(9, 7)])).toEqual(["tiebreak_score"]);
    expect(codes(DOUBLES, [{ a: 6, b: 4 }, { a: 4, b: 6 }, { a: 1, b: 0, tb: { a: 8, b: 10 } }])).toEqual(["tiebreak_score"]);
    // Before the sets are level it is an ordinary set.
    expect(codes(DOUBLES, [matchTiebreakSet(10, 8), { a: 6, b: 4 }])).toEqual(["set_score"]);
    // Best of five: the match tie-break comes at two sets all.
    expect(
      codes(BEST_OF_FIVE_MTB, [{ a: 6, b: 4 }, { a: 4, b: 6 }, { a: 6, b: 4 }, { a: 4, b: 6 }, matchTiebreakSet(7, 10)]),
    ).toEqual([]);
  });

  it("says which kind of set comes next", () => {
    expect(setKindAt(DOUBLES, [])).toBe("set");
    expect(setKindAt(DOUBLES, [{ a: 6, b: 4 }])).toBe("set");
    expect(setKindAt(DOUBLES, [{ a: 6, b: 4 }, { a: 4, b: 6 }])).toBe("match_tiebreak");
    expect(setKindAt(SINGLES, [{ a: 6, b: 4 }, { a: 4, b: 6 }])).toBe("set");
    expect(setKindAt(PADEL, [])).toBe("set");
  });

  it("completes a tie-break from the loser's points", () => {
    expect(completeTiebreak(PADEL, "A", 5)).toEqual({ a: 7, b: 5 });
    expect(completeTiebreak(PADEL, "B", 9)).toEqual({ a: 9, b: 11 });
    expect(completeTiebreak(FAST4, "A", 4)).toEqual({ a: 5, b: 4 });
    expect(completeTiebreak(DOUBLES, "B", 8, "match_tiebreak")).toEqual({ a: 8, b: 10 });
    expect(completeTiebreak(DOUBLES, "A", 11, "match_tiebreak")).toEqual({ a: 13, b: 11 });
  });
});

describe("stateFromFinalScore", () => {
  it("builds a finished state with the entered sets", () => {
    const s = built(SINGLES, [{ a: 6, b: 4 }, { a: 6, b: 7, tb: { a: 5, b: 7 } }, { a: 7, b: 5 }]);
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe("A");
    expect(s.teamA.sets).toBe(2);
    expect(s.teamB.sets).toBe(1);
    expect(s.completedSets).toEqual([
      { teamAGames: 6, teamBGames: 4 },
      { teamAGames: 6, teamBGames: 7, tiebreak: { a: 5, b: 7 } },
      { teamAGames: 7, teamBGames: 5 },
    ]);
    expect(scoreSummary(s)).toBe("6-4 6-7(5) 7-5");
  });

  it("keeps the tie-break points (not the 0-0 a game award would leave)", () => {
    const s = built(PADEL, [{ a: 7, b: 6, tb: { a: 10, b: 8 } }]);
    expect(s.completedSets[0].tiebreak).toEqual({ a: 10, b: 8 });
    expect(s.isTiebreak).toBe(true); // the engine leaves the flag as the match ended in it
  });

  it("records a match tie-break as the engine does", () => {
    const s = built(DOUBLES, [{ a: 4, b: 6 }, { a: 6, b: 3 }, matchTiebreakSet(8, 10)]);
    expect(s.winner).toBe("B");
    expect(s.completedSets[2]).toEqual({ teamAGames: 0, teamBGames: 1, tiebreak: { a: 8, b: 10 }, matchTiebreak: true });
    expect(scoreSummary(s)).toBe("4-6 6-3 [8-10]");
  });

  it("returns the problems instead of a state for a bad score", () => {
    const r = stateFromFinalScore(PADEL, [{ a: 7, b: 6 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0].code).toBe("tiebreak_required");
  });

  it("honours the first server", () => {
    const a = built(PADEL, [{ a: 6, b: 1 }]);
    const b = stateFromFinalScore(PADEL, [{ a: 6, b: 1 }], { firstServer: "B" });
    expect(b.ok && b.state.completedSets).toEqual(a.completedSets);
  });

  it("round-trips through enteredSetsFromState", () => {
    const sets: EnteredSet[] = [{ a: 6, b: 4 }, { a: 4, b: 6 }, matchTiebreakSet(10, 6)];
    expect(enteredSetsFromState(built(DOUBLES, sets))).toEqual(sets);
  });
});

describe("finalScoreSummary", () => {
  it("names the winner and reads the sets both ways", () => {
    const s = built(DOUBLES, [{ a: 4, b: 6 }, { a: 7, b: 6, tb: { a: 7, b: 3 } }, matchTiebreakSet(5, 10)]);
    expect(finalScoreSummary(s)).toEqual({
      winner: "B",
      setsWon: { a: 1, b: 2 },
      sets: "4-6 7-6(3) [5-10]",
      setsWinnerFirst: "6-4 6-7(3) [10-5]",
    });
    expect(finalScoreSummary(built(PADEL, [{ a: 6, b: 2 }]))).toEqual({
      winner: "A",
      setsWon: { a: 1, b: 0 },
      sets: "6-2",
      setsWinnerFirst: "6-2",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Property: point-by-point matches → set scores → same final state     */
/* ------------------------------------------------------------------ */

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playRandomMatch(rules: MatchRules, random: () => number): ScoreState {
  // Close matches are where the tie-breaks are, so most matches are near 50/50.
  const pA = 0.35 + random() * 0.3;
  const first: TeamKey = random() < 0.5 ? "A" : "B";
  let s = initialScoreState(first);
  for (let i = 0; i < 20_000 && !s.matchOver; i++) s = awardPoint(s, random() < pA ? "A" : "B", rules);
  return s;
}

describe("property: final-score entry agrees with point-by-point play", () => {
  for (const [name, rules] of Object.entries(RULE_SETS)) {
    it(`${name}: 300 random matches rebuild to the same result`, () => {
      const random = rng(name.length * 7919 + name.charCodeAt(0));
      let tiebreaks = 0;
      for (let n = 0; n < 300; n++) {
        const played = playRandomMatch(rules, random);
        expect(played.matchOver).toBe(true);
        const sets = enteredSetsFromState(played);
        tiebreaks += sets.filter((x) => x.tb).length;
        expect(validateFinalScore(rules, sets)).toEqual([]);
        const r = stateFromFinalScore(rules, sets);
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        expect(r.state.winner).toBe(played.winner);
        expect(r.state.completedSets).toEqual(played.completedSets);
        expect(r.state.teamA.sets).toBe(played.teamA.sets);
        expect(r.state.teamB.sets).toBe(played.teamB.sets);
        expect(scoreSummary(r.state)).toBe(scoreSummary(played));
      }
      // The run must actually exercise tie-breaks where the rules have them.
      if (rules.tiebreakEnabled || rules.matchTiebreak) expect(tiebreaks).toBeGreaterThan(0);
    });
  }

  it("rejects random perturbations of real scores or rebuilds them exactly", () => {
    const random = rng(42);
    for (let n = 0; n < 400; n++) {
      const rules = Object.values(RULE_SETS)[n % Object.keys(RULE_SETS).length];
      const sets = enteredSetsFromState(playRandomMatch(rules, random));
      const i = Math.floor(random() * sets.length);
      const bump = random() < 0.5 ? 1 : -1;
      const mutated = sets.map((s, k) => (k === i ? { ...s, a: Math.max(0, s.a + bump) } : s));
      const r = stateFromFinalScore(rules, mutated);
      if (r.ok) {
        // Whatever is accepted is exactly what the engine records.
        expect(enteredSetsFromState(r.state)).toEqual(mutated);
      } else {
        expect(r.problems.length).toBeGreaterThan(0);
        expect(r.problems.map((p) => p.code)).not.toContain("unreachable");
      }
    }
  });
});
