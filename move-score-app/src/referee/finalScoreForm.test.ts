import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING_CONFIG, validateFinalScore, type MatchRules } from "@core";
import { EMPTY_ROW, digits, needsTiebreak, rowsFrom, setsFrom, visibleRows, type Row } from "./finalScoreForm";

// Best of three, tie-break at 6-6 to 7, a match tie-break to 10 instead of a third set.
const rules: MatchRules = { ...DEFAULT_SCORING_CONFIG, setsToWinMatch: 2, gamesToWinSet: 6, tiebreakEnabled: true, tiebreakAtGames: 6, tiebreakTargetPoints: 7, matchTiebreak: true, matchTiebreakPoints: 10 };
const row = (a: string, b: string, tb = ""): Row => ({ a, b, tb });

describe("final score form rows", () => {
  it("keeps digits only, two at most", () => {
    expect(digits("7a")).toBe("7");
    expect(digits("123")).toBe("12");
  });

  it("asks for tie-break points only on a set that ended at the tie-break score", () => {
    expect(needsTiebreak(rules, row("7", "6"))).toBe(true);
    expect(needsTiebreak(rules, row("6", "7"))).toBe(true);
    expect(needsTiebreak(rules, row("7", "5"))).toBe(false);
    expect(needsTiebreak({ ...rules, tiebreakEnabled: false }, row("7", "6"))).toBe(false);
  });

  it("completes the tie-break from the loser's points: 7-6(5) is 7-5, 7-6(9) is 11-9", () => {
    expect(setsFrom(rules, [row("7", "6", "5")])[0].tb).toEqual({ a: 7, b: 5 });
    expect(setsFrom(rules, [row("6", "7", "9")])[0].tb).toEqual({ a: 9, b: 11 });
  });

  it("a 7-6 set without its tie-break points is refused (tie-break points required)", () => {
    const problems = validateFinalScore(rules, setsFrom(rules, [row("7", "6"), row("6", "3")]));
    expect(problems.map((p) => p.code)).toContain("tiebreak_required");
  });

  it("a one-set-all match is decided by a match tie-break typed as its points", () => {
    const rows = [row("6", "4"), row("3", "6"), row("10", "8"), { ...EMPTY_ROW }];
    const sets = setsFrom(rules, rows);
    expect(sets[2]).toEqual({ a: 1, b: 0, tb: { a: 10, b: 8 } });
    expect(validateFinalScore(rules, sets)).toEqual([]);
    expect(visibleRows(rules, rows).map((r) => r.label)).toEqual(["Set 1", "Set 2", "Match tie-break"]);
  });

  it("shows a row only once the ones before it are filled, and names who lost the tie-break", () => {
    const v = visibleRows(rules, [row("7", "6"), { ...EMPTY_ROW }, { ...EMPTY_ROW }]);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ tiebreak: true, tiebreakLoser: "B" });
  });

  it("starts a correction (or a refused result) from the entered sets", () => {
    const rows = rowsFrom(rules, [{ a: 7, b: 6, tb: { a: 7, b: 5 } }, { a: 4, b: 6 }, { a: 1, b: 0, tb: { a: 10, b: 7 } }], 3);
    expect(rows).toEqual([row("7", "6", "5"), row("4", "6"), row("10", "7")]);
    expect(setsFrom(rules, rows)).toEqual([{ a: 7, b: 6, tb: { a: 7, b: 5 } }, { a: 4, b: 6 }, { a: 1, b: 0, tb: { a: 10, b: 7 } }]);
  });
});
