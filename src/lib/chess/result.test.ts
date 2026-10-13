import { describe, expect, it } from "vitest";
import * as Engine from "./engine";
import {
  CHESS_START_FEN,
  chessGamePoints,
  chessOutcome,
  chessScoreLine,
  chessStateFromResults,
  validateChessResults,
  type ChessGameResult,
} from "./result";

function build(games: ChessGameResult[], competition: "group" | "swiss" | "league" | "knockout", legs: 1 | 2 = 1) {
  const r = chessStateFromResults(games, { competition, legs });
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r;
}

describe("chess results", () => {
  it("scores a game 1 / ½ / 0", () => {
    expect(chessGamePoints("A")).toEqual({ a: 1, b: 0 });
    expect(chessGamePoints("B")).toEqual({ a: 0, b: 1 });
    expect(chessGamePoints("draw")).toEqual({ a: 0.5, b: 0.5 });
  });

  it("a draw is a finished result in groups, Swiss and leagues", () => {
    for (const c of ["group", "swiss", "league"] as const) {
      expect(chessOutcome(["draw"], c)).toEqual({ points: { a: 0.5, b: 0.5 }, winner: null, draw: true, advance: null });
      const { state } = build(["draw"], c);
      expect(state.matchOver).toBe(true);
      expect(state.winner).toBeNull();
      expect(state.needsArbiter).toBe(false);
    }
  });

  it("a knockout draw asks the organiser who advances", () => {
    expect(chessOutcome(["draw"], "knockout").advance).toBe("organiser_decides");
    expect(chessOutcome(["A", "B"], "knockout")).toEqual({ points: { a: 1, b: 1 }, winner: null, draw: false, advance: "organiser_decides" });
    const { state } = build(["draw"], "knockout");
    expect(state.matchOver).toBe(false);
    expect(state.needsArbiter).toBe(true);
    // The organiser's decision is the engine's arbiter decision.
    const decided = Engine.decideWinner(state, "B");
    expect(decided).toMatchObject({ matchOver: true, winner: "B", needsArbiter: false });
  });

  it("a decisive knockout advances the winner", () => {
    expect(chessOutcome(["B"], "knockout").advance).toBe("B");
    expect(chessOutcome(["A", "draw"], "knockout")).toMatchObject({ points: { a: 1.5, b: 0.5 }, winner: "A", advance: "A" });
    const { state } = build(["draw", "B"], "knockout", 2);
    expect(state).toMatchObject({ matchOver: true, winner: "B", scoreA: 0.5, scoreB: 1.5, needsArbiter: false });
  });

  it("alternates colours like the engine and matches its state for the same results", () => {
    // Engine path: game 1 drawn by agreement, game 2 resigned by A (B wins).
    let e = Engine.newChessState(2);
    e = Engine.declareDraw(e);
    e = Engine.resign(e, "A");
    const { state } = build(["draw", "B"], "knockout", 2);
    expect(state.games.map((g) => g.whiteSide)).toEqual(["A", "B"]);
    expect(state.games.map((g) => g.result)).toEqual(e.games.map((g) => g.result));
    expect({ ...state, games: [] }).toEqual({ ...e, games: [] });
    expect(state.games[0].fen).toBe(CHESS_START_FEN);
    expect(Engine.matchScoreSummary(state)).toBe("½ - 1½");
    // The restated types stay assignable to the engine's.
    const asEngine: Engine.ChessState = state;
    expect(asEngine.legs).toBe(2);
  });

  it("validates entered results", () => {
    expect(validateChessResults([], 1)[0].code).toBe("no_games");
    expect(validateChessResults(["A"], 2)[0].code).toBe("wrong_game_count");
    expect(validateChessResults(["A", "B"], 1)[0].code).toBe("wrong_game_count");
    expect(validateChessResults(["win"], 1)[0].code).toBe("not_a_result");
    expect(validateChessResults(["draw"], 1)).toEqual([]);
    const r = chessStateFromResults(["A"], { competition: "knockout", legs: 2 });
    expect(r.ok).toBe(false);
  });

  it("writes the score line", () => {
    expect(chessScoreLine({ a: 1, b: 0 })).toBe("1 - 0");
    expect(chessScoreLine({ a: 0.5, b: 0.5 })).toBe("½ - ½");
    expect(chessScoreLine({ a: 1.5, b: 0.5 })).toBe("1½ - ½");
  });
});
