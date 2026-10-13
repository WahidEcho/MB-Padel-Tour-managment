import { describe, expect, it } from "vitest";
import { buildResultState, chessCompetitionFor, finalResultAllowed, parseResultPayload } from "./resultEntry";
import { stateFromFinalScore } from "./finalScore";
import { DEFAULT_SCORING_CONFIG, DEFAULT_TENNIS_SCORING_CONFIG, type MatchRules } from "../types";

const PADEL: MatchRules = DEFAULT_SCORING_CONFIG;
const BEST_OF_3_MTB: MatchRules = { ...DEFAULT_TENNIS_SCORING_CONFIG, setsToWinMatch: 2, matchTiebreak: true, matchTiebreakPoints: 10 };

describe("parseResultPayload", () => {
  it("takes sets with optional tie-breaks", () => {
    const r = parseResultPayload({ sets: [{ a: 7, b: 6, tb: { a: 7, b: 5 } }, { a: 6, b: 2, tb: null }] }, "games");
    expect(r).toEqual({ ok: true, payload: { sets: [{ a: 7, b: 6, tb: { a: 7, b: 5 } }, { a: 6, b: 2 }] } });
  });
  it("refuses unknown fields, wrong types and oversized input", () => {
    expect(parseResultPayload({ sets: [{ a: 6, b: 4 }], state: {} }, "games").ok).toBe(false);
    expect(parseResultPayload({ sets: [{ a: 6, b: 4, x: 1 }] }, "games").ok).toBe(false);
    expect(parseResultPayload({ sets: [{ a: "6", b: 4 }] }, "games").ok).toBe(false);
    expect(parseResultPayload({ sets: [{ a: 6.5, b: 4 }] }, "games").ok).toBe(false);
    expect(parseResultPayload({ sets: [{ a: 100, b: 4 }] }, "games").ok).toBe(false);
    expect(parseResultPayload({ sets: Array.from({ length: 10 }, () => ({ a: 6, b: 0 })) }, "games").ok).toBe(false);
    expect(parseResultPayload({ sets: [] }, "games").ok).toBe(false);
    expect(parseResultPayload(null, "games").ok).toBe(false);
  });
  it("takes chess games and who advances", () => {
    expect(parseResultPayload({ chess: ["draw"], advance: "B" }, "chess")).toEqual({ ok: true, payload: { chess: ["draw"], advance: "B" } });
    expect(parseResultPayload({ chess: ["A", "draw"] }, "chess")).toEqual({ ok: true, payload: { chess: ["A", "draw"] } });
    expect(parseResultPayload({ chess: ["white"] }, "chess").ok).toBe(false);
    expect(parseResultPayload({ chess: ["A", "B", "A"] }, "chess").ok).toBe(false);
    expect(parseResultPayload({ chess: ["A"], advance: "C" }, "chess").ok).toBe(false);
    expect(parseResultPayload({ sets: [{ a: 6, b: 4 }] }, "chess").ok).toBe(false);
  });
});

describe("buildResultState", () => {
  it("builds the engine's finished state for games", () => {
    const r = buildResultState({ engine: "games", rules: BEST_OF_3_MTB, payload: { sets: [{ a: 4, b: 6 }, { a: 7, b: 6, tb: { a: 7, b: 3 } }, { a: 1, b: 0, tb: { a: 10, b: 8 } }] } });
    expect(r.ok).toBe(true);
    if (!r.ok || r.engine !== "games") return;
    expect(r.winner).toBe("A");
    expect(r.state).toEqual((stateFromFinalScore(BEST_OF_3_MTB, [{ a: 4, b: 6 }, { a: 7, b: 6, tb: { a: 7, b: 3 } }, { a: 1, b: 0, tb: { a: 10, b: 8 } }]) as { state: unknown }).state);
  });
  it("refuses a score the rules cannot produce, with typed problems", () => {
    const r = buildResultState({ engine: "games", rules: PADEL, payload: { sets: [{ a: 7, b: 6 }] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.code)).toEqual(["tiebreak_required"]);
    const bad = buildResultState({ engine: "games", rules: PADEL, payload: { sets: [{ a: 6, b: 5 }] } });
    if (!bad.ok) expect(bad.problems[0].code).toBe("set_score");
  });
  it("chess: a won game finishes a knockout; a draw is level and asks the organiser", () => {
    const won = buildResultState({ engine: "chess", rules: PADEL, payload: { chess: ["B"] }, competition: "knockout" });
    expect(won.ok && won.engine === "chess" && won.winner === "B" && won.state.matchOver && !won.level).toBe(true);
    const level = buildResultState({ engine: "chess", rules: PADEL, payload: { chess: ["draw"] }, competition: "knockout" });
    expect(level.ok && level.engine === "chess" && level.level && !level.state.matchOver && level.state.needsArbiter).toBe(true);
    const decided = buildResultState({ engine: "chess", rules: PADEL, payload: { chess: ["A", "B"], advance: "A" }, competition: "knockout", legs: 2 });
    expect(decided.ok && decided.engine === "chess" && decided.advance === "A").toBe(true);
  });
  it("chess: who advances is refused for a pairing one side won, and draws outside a knockout are not supported yet", () => {
    const r = buildResultState({ engine: "chess", rules: PADEL, payload: { chess: ["A"], advance: "B" }, competition: "knockout" });
    expect(!r.ok && r.problems[0].code).toBe("advance_not_needed");
    const g = buildResultState({ engine: "chess", rules: PADEL, payload: { chess: ["draw"] }, competition: "group" });
    expect(!g.ok && g.problems[0].code).toBe("draw_unsupported");
    const wrongCount = buildResultState({ engine: "chess", rules: PADEL, payload: { chess: ["A"] }, competition: "knockout", legs: 2 });
    expect(!wrongCount.ok && wrongCount.problems[0].code).toBe("wrong_game_count");
  });
});

describe("modes and competitions", () => {
  it("allows a final result only in final_score or either", () => {
    expect(finalResultAllowed("final_score")).toBe(true);
    expect(finalResultAllowed("either")).toBe(true);
    expect(finalResultAllowed("point_by_point")).toBe(false);
    expect(finalResultAllowed(undefined)).toBe(false);
  });
  it("reads a chess competition from the stage", () => {
    expect(chessCompetitionFor("group")).toBe("group");
    expect(chessCompetitionFor("friendly")).toBe("league");
    expect(chessCompetitionFor("final")).toBe("knockout");
    expect(chessCompetitionFor("round_of_16")).toBe("knockout");
  });
});
