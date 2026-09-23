import { describe, it, expect } from "vitest";
import { scoringConfigForMatch } from "../scoring/rules";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";
import { fromSideA, parseResult, replayResult } from "./replay";

const tournament = { sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG };
const singles = scoringConfigForMatch(tournament, { stage: "knockout" });
const doubles = scoringConfigForMatch(tournament, { stage: "knockout" }, null, { doubles: true });
const line = (r: ReturnType<typeof replayResult>) =>
  r.states[r.states.length - 1].completedSets
    .map((c) => (c.matchTiebreak ? `[${c.tiebreak!.a}-${c.tiebreak!.b}]` : `${c.teamAGames}-${c.teamBGames}${c.tiebreak ? `(${Math.min(c.tiebreak.a, c.tiebreak.b)})` : ""}`))
    .join(" ");

describe("reading a result line", () => {
  it("reads sets, tie-break sets and a match tie-break", () => {
    expect(parseResult("6-4 3-6 [10-8]")).toEqual([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 10, b: 8, matchTiebreak: true }]);
    expect(parseResult("7-6(5) 6-2")).toEqual([{ a: 7, b: 6, tiebreakLoser: 5 }, { a: 6, b: 2 }]);
    expect(parseResult("six four")).toBeNull();
  });
  it("turns the winner's line round for team B", () => {
    expect(fromSideA("7-5 6-4", "B")).toBe("5-7 4-6");
    expect(fromSideA("6-1 3-6 [10-8]", "B")).toBe("1-6 6-3 [8-10]");
    expect(fromSideA("6-2 6-1", "A")).toBe("6-2 6-1");
  });
});

describe("replaying the real finals point by point", () => {
  // 2024 Junior BJK Cup final, USA d. Romania 2-1; 2025 Junior Davis Cup final, USA d. Japan 2-0.
  const cases: [string, typeof singles][] = [
    ["6-2 6-1", singles], // Grant d. Burcescu
    ["5-7 4-6", singles], // Pareja lost to Popa
    ["6-1 7-5", doubles], // Grant / Pareja d. Popa / Burcescu
    ["6-4 6-3", singles], // Johnson d. Kawaguchi
    ["6-3 6-2", singles], // Antonius d. Watanabe
  ];
  for (const [score, config] of cases) {
    it(`ends exactly on ${score}, for any seed`, () => {
      for (let seed = 1; seed <= 25; seed++) expect(line(replayResult(score, config, seed))).toBe(score);
    });
  }

  it("plays tie-breaks and a match tie-break", () => {
    expect(line(replayResult("7-6(5) 6-7(8) [10-8]", doubles, 3))).toBe("7-6(5) 6-7(8) [10-8]");
    expect(line(replayResult("7-6(3) 7-6(10)", singles, 4))).toBe("7-6(3) 7-6(10)");
  });

  it("goes through deuces, and under no-ad through deciding points", () => {
    const r = replayResult("6-4 6-4", doubles, 7);
    const deciding = r.states.filter((s) => !s.isTiebreak && s.teamA.points === "40" && s.teamB.points === "40");
    expect(deciding.length).toBeGreaterThan(0);
    expect(r.states.some((s) => s.teamA.points === "AD" || s.teamB.points === "AD")).toBe(false);
    const adv = replayResult("6-4 6-4", singles, 7);
    expect(adv.states.some((s) => s.teamA.points === "AD" || s.teamB.points === "AD")).toBe(true);
  });

  it("is the same every time for a seed, and different across seeds", () => {
    expect(replayResult("6-4 6-3", singles, 9).points).toEqual(replayResult("6-4 6-3", singles, 9).points);
    expect(replayResult("6-4 6-3", singles, 9).points).not.toEqual(replayResult("6-4 6-3", singles, 10).points);
  });

  it("refuses a score the rules cannot reach", () => {
    expect(() => replayResult("6-4 3-6 [10-8]", singles)).toThrow(); // singles plays a full third set
    expect(() => replayResult("6-4", singles)).toThrow(); // best of three
    expect(() => replayResult("nonsense", singles)).toThrow();
  });
});
