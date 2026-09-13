import { describe, it, expect } from "vitest";
import {
  describeMatchRules,
  scoringConfigForMatch,
  stageRuleKey,
  validateMatchRules,
} from "./rules";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig, type Stage } from "../types";

const STAGES: Stage[] = [
  "group",
  "quarter_final",
  "semi_final",
  "final",
  "third_place",
  "knockout",
  "friendly",
];

describe("stageRuleKey", () => {
  it("buckets every stage", () => {
    expect(STAGES.map((s) => stageRuleKey(s))).toEqual([
      "group",
      "quarter_semi",
      "quarter_semi",
      "final",
      "quarter_semi",
      "bracket",
      null,
    ]);
  });

  it("puts the third-place match with the semis, not the final", () => {
    expect(stageRuleKey("third_place")).toBe(stageRuleKey("semi_final"));
    expect(stageRuleKey("third_place")).not.toBe(stageRuleKey("final"));
  });

  it("friendly matches never take an override", () => {
    expect(stageRuleKey("friendly")).toBeNull();
    expect(stageRuleKey("friendly", "plate")).toBeNull();
  });

  it("prefixes knockout buckets for the Plate but not the group stage", () => {
    expect(stageRuleKey("final", "plate")).toBe("plate_final");
    expect(stageRuleKey("semi_final", "plate")).toBe("plate_quarter_semi");
    expect(stageRuleKey("knockout", "plate")).toBe("plate_bracket");
    expect(stageRuleKey("group", "plate")).toBe("group");
  });

  it("treats the cup tier as the unprefixed default", () => {
    for (const s of STAGES) expect(stageRuleKey(s, "cup")).toBe(stageRuleKey(s));
  });
});

describe("scoringConfigForMatch", () => {
  it("falls back to the built-in defaults when nothing is configured", () => {
    expect(scoringConfigForMatch(null, { stage: "final" })).toEqual(DEFAULT_SCORING_CONFIG);
    expect(scoringConfigForMatch({ scoring_config: null }, { stage: "group" })).toEqual(
      DEFAULT_SCORING_CONFIG,
    );
  });

  it("uses the tournament config when there are no overrides", () => {
    const t = { scoring_config: { setsToWinMatch: 2, gamesToWinSet: 4 } };
    const resolved = scoringConfigForMatch(t, { stage: "quarter_final" });
    expect(resolved.setsToWinMatch).toBe(2);
    expect(resolved.gamesToWinSet).toBe(4);
    // Untouched fields still come from the defaults.
    expect(resolved.tiebreakTargetPoints).toBe(DEFAULT_SCORING_CONFIG.tiebreakTargetPoints);
  });

  it("applies only the override for the match's own bucket", () => {
    const t: { scoring_config: Partial<ScoringConfig> } = {
      scoring_config: {
        setsToWinMatch: 1,
        stageOverrides: {
          final: { setsToWinMatch: 2 },
          group: { gamesToWinSet: 4 },
        },
      },
    };
    expect(scoringConfigForMatch(t, { stage: "final" }).setsToWinMatch).toBe(2);
    expect(scoringConfigForMatch(t, { stage: "final" }).gamesToWinSet).toBe(
      DEFAULT_SCORING_CONFIG.gamesToWinSet,
    );
    expect(scoringConfigForMatch(t, { stage: "semi_final" }).setsToWinMatch).toBe(1);
    expect(scoringConfigForMatch(t, { stage: "group" }).gamesToWinSet).toBe(4);
  });

  it("a partial override keeps every other field", () => {
    const t: { scoring_config: Partial<ScoringConfig> } = {
      scoring_config: {
        gamesToWinSet: 4,
        tiebreakTargetPoints: 5,
        stageOverrides: { final: { setsToWinMatch: 2 } },
      },
    };
    const resolved = scoringConfigForMatch(t, { stage: "final" });
    expect(resolved).toMatchObject({ setsToWinMatch: 2, gamesToWinSet: 4, tiebreakTargetPoints: 5 });
  });

  it("a friendly match ignores overrides entirely", () => {
    const t: { scoring_config: Partial<ScoringConfig> } = {
      scoring_config: { setsToWinMatch: 1, stageOverrides: { final: { setsToWinMatch: 3 } } },
    };
    expect(scoringConfigForMatch(t, { stage: "friendly" }).setsToWinMatch).toBe(1);
  });

  it("the Plate inherits the Cup's override when it has none of its own", () => {
    const t: { scoring_config: Partial<ScoringConfig> } = {
      scoring_config: { stageOverrides: { final: { setsToWinMatch: 2 } } },
    };
    expect(scoringConfigForMatch(t, { stage: "final" }, "plate").setsToWinMatch).toBe(2);
  });

  it("a Plate override wins over the Cup's, field by field", () => {
    const t: { scoring_config: Partial<ScoringConfig> } = {
      scoring_config: {
        stageOverrides: {
          final: { setsToWinMatch: 2, gamesToWinSet: 6 },
          plate_final: { setsToWinMatch: 1 },
        },
      },
    };
    const plate = scoringConfigForMatch(t, { stage: "final" }, "plate");
    expect(plate.setsToWinMatch).toBe(1);
    // gamesToWinSet was only set on the Cup, so the Plate still inherits it.
    expect(plate.gamesToWinSet).toBe(6);
    expect(scoringConfigForMatch(t, { stage: "final" }, "cup").setsToWinMatch).toBe(2);
  });

  it("never lets stored json nest stageOverrides into a resolved config", () => {
    const t = {
      scoring_config: {
        stageOverrides: {
          final: { setsToWinMatch: 2, stageOverrides: { group: { gamesToWinSet: 1 } } },
        },
      },
    } as unknown as { scoring_config: Partial<ScoringConfig> };
    const resolved = scoringConfigForMatch(t, { stage: "final" });
    expect(resolved.setsToWinMatch).toBe(2);
    expect(resolved.stageOverrides?.group).toBeUndefined();
  });
});

describe("validateMatchRules", () => {
  const rules = (over: Partial<typeof DEFAULT_SCORING_CONFIG> = {}) => ({
    ...DEFAULT_SCORING_CONFIG,
    ...over,
  });

  it("accepts the defaults", () => {
    expect(validateMatchRules(rules())).toEqual([]);
  });

  it("accepts a tie-break exactly at the set length", () => {
    expect(validateMatchRules(rules({ gamesToWinSet: 4, tiebreakAtGames: 4 }))).toEqual([]);
  });

  it("accepts a tie-break one game below the set length", () => {
    // 5-5 in a six-game set finishes 6-5, which is a real short-set format.
    expect(validateMatchRules(rules({ gamesToWinSet: 6, tiebreakAtGames: 5 }))).toEqual([]);
  });

  it("accepts an advantage set breaking at 12-12", () => {
    expect(validateMatchRules(rules({ gamesToWinSet: 6, tiebreakAtGames: 12 }))).toEqual([]);
  });

  it("rejects a tie-break that would end the set early", () => {
    const problems = validateMatchRules(rules({ gamesToWinSet: 6, tiebreakAtGames: 3 }));
    expect(problems.map((p) => p.field)).toEqual(["tiebreakAtGames"]);
    expect(problems[0].message).toContain("4 games");
  });

  it("ignores the tie-break trigger when tie-breaks are off", () => {
    expect(validateMatchRules(rules({ tiebreakEnabled: false, tiebreakAtGames: 1, gamesToWinSet: 9 }))).toEqual([]);
  });

  it("rejects non-whole and zero set or game counts", () => {
    expect(validateMatchRules(rules({ setsToWinMatch: 0 }))[0].field).toBe("setsToWinMatch");
    expect(validateMatchRules(rules({ gamesToWinSet: 1.5 }))[0].field).toBe("gamesToWinSet");
  });

  it("rejects a malformed walkover score", () => {
    expect(validateMatchRules(rules({ walkoverScore: "six-love" }))[0].field).toBe("walkoverScore");
  });
});

describe("describeMatchRules", () => {
  it("names a single set and a best-of-three", () => {
    expect(describeMatchRules({ ...DEFAULT_SCORING_CONFIG })).toContain("1 set");
    expect(describeMatchRules({ ...DEFAULT_SCORING_CONFIG, setsToWinMatch: 2 })).toContain("best of 3");
  });

  it("says when there is no tie-break, and flags an advantage set", () => {
    expect(describeMatchRules({ ...DEFAULT_SCORING_CONFIG, tiebreakEnabled: false })).toContain("no tie-break");
    expect(describeMatchRules({ ...DEFAULT_SCORING_CONFIG, tiebreakAtGames: 12 })).toContain("advantage set");
  });
});
