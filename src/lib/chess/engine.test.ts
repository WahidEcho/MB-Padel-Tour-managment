import { describe, it, expect } from "vitest";
import {
  applyMove,
  declareDraw,
  decideWinner,
  formatMovePairs,
  legalMovesFrom,
  newChessState,
  resign,
  sideToMove,
} from "./engine";

describe("chess engine", () => {
  it("records legal moves in SAN and advances the turn", () => {
    let s = newChessState(1);
    expect(sideToMove(s)).toBe("A"); // white = A moves first
    const r1 = applyMove(s, "e2", "e4");
    expect(r1.san).toBe("e4");
    s = r1.state;
    expect(s.games[0].sanHistory).toEqual(["e4"]);
    expect(sideToMove(s)).toBe("B");
    const r2 = applyMove(s, "e7", "e5");
    expect(r2.san).toBe("e5");
    expect(r2.state.games[0].sanHistory).toEqual(["e4", "e5"]);
  });

  it("rejects illegal moves without mutating state", () => {
    const s = newChessState(1);
    const r = applyMove(s, "e2", "e5"); // pawn can't jump three
    expect(r.san).toBeNull();
    expect(r.state).toBe(s);
    expect(r.state.games[0].sanHistory).toEqual([]);
  });

  it("lists legal destination squares for a piece", () => {
    const s = newChessState(1);
    const moves = legalMovesFrom(s, "e2").map((m) => m.to).sort();
    expect(moves).toEqual(["e3", "e4"]);
    const knight = legalMovesFrom(s, "g1").map((m) => m.to).sort();
    expect(knight).toEqual(["f3", "h3"]);
  });

  it("detects fool's-mate checkmate and finalizes a 1-leg match for the winner", () => {
    let s = newChessState(1);
    // 1. f3 e5 2. g4 Qh4#
    for (const [from, to] of [
      ["f2", "f3"],
      ["e7", "e5"],
      ["g2", "g4"],
      ["d8", "h4"],
    ] as const) {
      s = applyMove(s, from, to).state;
    }
    expect(s.games[0].endReason).toBe("checkmate");
    expect(s.games[0].result).toBe("black"); // black (player B) delivered mate
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe("B");
    expect(s.scoreB).toBe(1);
  });

  it("resignation hands the game to the opponent", () => {
    let s = newChessState(1);
    s = applyMove(s, "e2", "e4").state;
    s = resign(s, "A"); // white (A) resigns
    expect(s.games[0].endReason).toBe("resignation");
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe("B");
  });

  it("a drawn 1-leg game needs an arbiter decision, then resolves", () => {
    let s = newChessState(1);
    s = applyMove(s, "e2", "e4").state;
    s = declareDraw(s);
    expect(s.scoreA).toBe(0.5);
    expect(s.scoreB).toBe(0.5);
    expect(s.needsArbiter).toBe(true);
    expect(s.matchOver).toBe(false);
    s = decideWinner(s, "A");
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe("A");
    expect(s.needsArbiter).toBe(false);
  });

  it("2-leg match: starts a reversed-colour second game, aggregates, ties go to arbiter", () => {
    let s = newChessState(2);
    expect(s.games[0].whiteSide).toBe("A");
    // Game 1: A (white) wins by resignation of B.
    s = resign(s, "B");
    expect(s.matchOver).toBe(false);
    expect(s.currentGameIndex).toBe(1);
    expect(s.games[1].whiteSide).toBe("B"); // colours reversed
    expect(s.scoreA).toBe(1);
    // Game 2: B (white) wins → 1-1 aggregate → arbiter.
    s = resign(s, "A");
    expect(s.scoreA).toBe(1);
    expect(s.scoreB).toBe(1);
    expect(s.needsArbiter).toBe(true);
    expect(s.matchOver).toBe(false);
    s = decideWinner(s, "B");
    expect(s.winner).toBe("B");
    expect(s.matchOver).toBe(true);
  });

  it("2-leg match decisive on aggregate finalizes without an arbiter", () => {
    let s = newChessState(2);
    s = resign(s, "B"); // A wins game 1
    s = resign(s, "B"); // game 2: B (white) resigns → A wins again
    expect(s.scoreA).toBe(2);
    expect(s.scoreB).toBe(0);
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe("A");
  });

  it("formats SAN history into numbered pairs", () => {
    expect(formatMovePairs(["e4", "e5", "Nf3", "Nc6", "Bb5"])).toEqual([
      "1. e4 e5",
      "2. Nf3 Nc6",
      "3. Bb5",
    ]);
  });
});
