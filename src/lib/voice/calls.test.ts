import { describe, it, expect } from "vitest";
import {
  awardPoint,
  changeServer,
  initialScoreState,
  manualEndSet,
  type ScoreState,
  type TeamKey,
} from "../scoring/engine";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "../types";
import { bigPoint, callForTransition, classifyEvent, gamesTally, sameScore, tiebreakNumbers } from "./calls";
import { PHRASES, TEST_CALL, captionFor } from "./phrases";

const one: ScoringConfig = DEFAULT_SCORING_CONFIG; // one set to 6, tie-break to 7 at 6-6
const bestOf3: ScoringConfig = { ...one, setsToWinMatch: 2 };

/** Plays "AABBA…" — one character per point, A or B. */
function play(state: ScoreState, points: string, config = one): ScoreState {
  let s = state;
  for (const c of points) s = awardPoint(s, c as TeamKey, config);
  return s;
}

function games(state: ScoreState, winners: string, config = one): ScoreState {
  let s = state;
  for (const c of winners) s = play(s, c.repeat(4), config);
  return s;
}

const POINT = { corrects: false, netPoints: 1 };
const UNDO = { corrects: true, netPoints: -1 };

/** The call for one more point by `team`. */
function afterPoint(from: ScoreState, team: TeamKey, config = one) {
  return callForTransition(from, awardPoint(from, team, config), POINT, config);
}

describe("classifying referee events", () => {
  it("sorts every event the scoring page sends", () => {
    expect(["POINT_AWARDED", "UNDO", "MANUAL_SET_END"].map(classifyEvent)).toEqual(["scoring", "scoring", "scoring"]);
    expect(["MATCH_STARTED", "SERVER_CHANGED", "MATCH_PAUSED", "MATCH_RESUMED", "MATCH_ENDED"].map(classifyEvent)).toEqual([
      "passive", "passive", "passive", "passive", "passive",
    ]);
    expect(["FORCE_END", "WALKOVER", "RETIREMENT", "DISQUALIFICATION"].map(classifyEvent)).toEqual([
      "terminal", "terminal", "terminal", "terminal",
    ]);
  });
});

describe("point calls, server first", () => {
  it("calls the server's score first whichever team serves", () => {
    expect(afterPoint(initialScoreState("A"), "A")).toEqual(["pts-15-0"]);
    expect(afterPoint(initialScoreState("A"), "B")).toEqual(["pts-0-15"]);
    expect(afterPoint(initialScoreState("B"), "A")).toEqual(["pts-0-15"]);
    expect(afterPoint(initialScoreState("B"), "B")).toEqual(["pts-15-0"]);
  });

  it("calls level scores as all, and forty all as deuce", () => {
    expect(afterPoint(play(initialScoreState("A"), "A"), "B")).toEqual(["pts-15-15"]);
    expect(afterPoint(play(initialScoreState("A"), "AAABB"), "B")).toEqual(["pts-40-40"]);
    expect(PHRASES["pts-40-40"]).toBe("Deuce.");
    expect(PHRASES["pts-15-15"]).toBe("Fifteen all.");
  });

  it("calls advantage by side, and back to deuce", () => {
    const deuce = play(initialScoreState("A"), "AAABBB");
    expect(afterPoint(deuce, "A")).toEqual(["adv-server"]);
    const advReceiver = awardPoint(deuce, "B", one);
    expect(callForTransition(deuce, advReceiver, POINT, one)).toEqual(["adv-receiver", "break-point"]);
    expect(afterPoint(advReceiver, "A")).toEqual(["pts-40-40"]);
  });

  it("adds break point when the receiver can take the game", () => {
    expect(afterPoint(play(initialScoreState("A"), "BB"), "B")).toEqual(["pts-0-40", "break-point"]);
    // Game point for the server is not called.
    expect(afterPoint(play(initialScoreState("A"), "AA"), "A")).toEqual(["pts-40-0"]);
  });
});

describe("game, set and match", () => {
  it("calls a held game with the tally from the next server's side", () => {
    // A serves game 1 and holds; B is about to serve, trailing one game to love.
    expect(afterPoint(play(initialScoreState("A"), "AAA"), "A")).toEqual(["game", "leads-receiver", "games-1-0"]);
    expect(PHRASES["games-1-0"]).toBe("one game to love.");
  });

  it("calls level games as all", () => {
    const s = games(initialScoreState("A"), "ABAB"); // 2-2
    // A holds for 3-2, so B serves next, trailing.
    expect(afterPoint(play(s, "AAA"), "A")).toEqual(["game", "leads-receiver", "games-3-2"]);
    expect(afterPoint(play(games(initialScoreState("A"), "ABA"), "BBB"), "B")).toEqual(["game", "games-all-2"]);
  });

  it("prefers set point to break point", () => {
    // A leads 5-4, B serves at 30 all; A's point makes 30-40, and A's next takes the set.
    const s = play(games(initialScoreState("A"), "ABABABABA", bestOf3), "BBAA", bestOf3);
    expect(afterPoint(s, "A", bestOf3)).toEqual(["pts-30-40", "set-point"]);
  });

  it("prefers match point to set point", () => {
    const s = play(games(initialScoreState("A"), "ABABABABA"), "BBAA");
    expect(afterPoint(s, "A")).toEqual(["pts-30-40", "match-point"]);
  });

  it("calls the match on the winning point", () => {
    const s = play(games(initialScoreState("A"), "AAAAA"), "AAA");
    expect(afterPoint(s, "A")).toEqual(["game-set-match"]);
  });

  it("calls a set won in best of three with the sets tally", () => {
    const s = play(games(initialScoreState("A"), "AAAAA", bestOf3), "AAA", bestOf3);
    // Six games: A served first, so A serves set two as well and leads it.
    expect(afterPoint(s, "A", bestOf3)).toEqual(["game-and-set", "leads-server", "sets-1-0"]);
  });

  it("calls a manual set end as Set", () => {
    const s = games(initialScoreState("A"), "AAAB", bestOf3);
    // Four games leave A serving; a manual end keeps the server.
    const to = manualEndSet(s, "A", bestOf3);
    expect(callForTransition(s, to, POINT, bestOf3)).toEqual(["set", "leads-server", "sets-1-0"]);
  });
});

describe("tie-breaks", () => {
  /** 6-6 with `first` serving the opening game. */
  function sixAll(first: TeamKey, config = one): ScoreState {
    return games(initialScoreState(first), "ABABABABABAB", config);
  }

  it("announces the tie-break on the game that makes six all", () => {
    const beforeTwelfth = play(games(initialScoreState("A"), "ABABABABABA"), "BBB");
    expect(afterPoint(beforeTwelfth, "B")).toEqual(["game", "games-all-6", "tie-break"]);
  });

  it("calls tie-break numbers with the rotating server first", () => {
    let s = sixAll("A"); // A serves point 1, B points 2-3, A points 4-5
    const calls: (string[] | null)[] = [];
    for (const team of ["A", "A", "B", "B"] as TeamKey[]) {
      calls.push(afterPoint(s, team));
      s = awardPoint(s, team, one);
    }
    expect(calls).toEqual([
      ["tb-0-1"], // 1-0 to A; B serves points 2 and 3
      ["tb-0-2"], // 2-0 to A; B still serves
      ["tb-2-1"], // A serves point 4 with 2 to B's 1
      ["tb-2-2"],
    ]);
  });

  it("adds set point in the tie-break, never break point", () => {
    const s = play(sixAll("A"), "AAAAA"); // 5-0 to A
    const call = afterPoint(s, "A");
    expect(call?.at(-1)).toBe("match-point");
    const bo3 = play(sixAll("A", bestOf3), "AAAAA", bestOf3);
    expect(afterPoint(bo3, "A", bestOf3)?.at(-1)).toBe("set-point");
    expect(bigPoint(play(sixAll("A"), "B"), one)).toBeNull();
  });

  it("builds long tie-break scores from number words", () => {
    let s = sixAll("A");
    s = play(s, "ABABABABABABABABAB"); // 9-9
    expect(tiebreakNumbers(s)).toEqual(["n-9", "all"]);
    s = awardPoint(s, "A", one); // 10-9 to A, who serves point 20
    expect(tiebreakNumbers(s)).toEqual(["n-10", "n-9"]);
  });

  it("stays silent in a tie-break whose server is unknown", () => {
    const legacy = { ...sixAll("A") };
    delete legacy.tiebreakFirstServer;
    expect(afterPoint(legacy, "A")).toBeNull();
  });

  it("uses the new set's server after a tie-break set", () => {
    const s = play(sixAll("A", bestOf3), "AAAAAA", bestOf3);
    // A served first in the tie-break, so B serves set two; A leads it.
    expect(afterPoint(s, "A", bestOf3)).toEqual(["game-and-set", "leads-receiver", "sets-1-0"]);
  });

  it("allows set point for both sides in a win-by-one tie-break", () => {
    const winByOne = { ...bestOf3, tiebreakWinByTwo: false };
    const s = play(sixAll("A", winByOne), "ABABABABABAB", winByOne); // 6-6 in the tie-break
    expect(bigPoint(s, winByOne)).toBe("set-point");
  });
});

describe("corrections and bursts", () => {
  it("is silent when a point and its undo cancel out", () => {
    const s = play(initialScoreState("A"), "A");
    expect(callForTransition(s, s, { corrects: true, netPoints: 0 }, one)).toBeNull();
  });

  it("says Correction and the standing score after an undo", () => {
    const fifteen = play(initialScoreState("A"), "A");
    expect(callForTransition(fifteen, initialScoreState("A"), UNDO, one)).toEqual(["correction", "pts-0-0"]);
    const thirty = play(initialScoreState("A"), "AB");
    expect(callForTransition(thirty, fifteen, UNDO, one)).toEqual(["correction", "pts-15-0"]);
  });

  it("calls an undo that lands on a reachable score as a correction", () => {
    // Undoing "Advantage server" gives deuce — the same board as the receiver scoring.
    const deuce = play(initialScoreState("A"), "AAABBB");
    const advantage = awardPoint(deuce, "A", one);
    expect(callForTransition(advantage, deuce, UNDO, one)).toEqual(["correction", "pts-40-40"]);
  });

  it("tallies the games when an undo takes a game back", () => {
    const before = play(games(initialScoreState("A"), "AB"), "AAAB"); // 1-1, 40-15 to A
    const after = awardPoint(before, "A", one); // 2-1
    const undone = before;
    expect(callForTransition(after, undone, UNDO, one)).toEqual(["correction", "games-all-1", "pts-40-15"]);
  });

  it("says zero all when an undo returns a tie-break to its start", () => {
    const start = games(initialScoreState("A"), "ABABABABABAB");
    const onePoint = awardPoint(start, "A", one);
    expect(callForTransition(onePoint, start, UNDO, one)).toEqual(["correction", "tb-0-0"]);
  });

  it("calls a burst of taps as the standing score, without Correction", () => {
    const from = initialScoreState("A");
    expect(callForTransition(from, play(from, "AA"), { corrects: false, netPoints: 2 }, one)).toEqual(["pts-30-0"]);
    // Across a game: the tally comes first.
    const g = play(from, "AAAAB");
    // A held, so B serves the next game with fifteen.
    expect(callForTransition(from, g, { corrects: false, netPoints: 5 }, one)).toEqual(["leads-receiver", "games-1-0", "pts-15-0"]);
  });

  it("does not call Correction when an undo only cancels a tap nobody heard", () => {
    // "Fifteen love" was called; then A, B, undo, B inside the next window.
    const spoken = play(initialScoreState("A"), "A");
    const to = play(spoken, "BB");
    expect(callForTransition(spoken, to, { corrects: false, netPoints: 2 }, one)).toEqual(["pts-15-30"]);
  });

  it("calls a set ended by hand on set point as Set, not Game and set", () => {
    const setPoint = play(games(initialScoreState("A"), "AAAAA", bestOf3), "AAA", bestOf3); // 5-0, 40-0
    const byHand = manualEndSet(setPoint, "A", bestOf3);
    expect(callForTransition(setPoint, byHand, POINT, bestOf3)?.[0]).toBe("set");
    const byPoint = awardPoint(setPoint, "A", bestOf3);
    expect(callForTransition(setPoint, byPoint, POINT, bestOf3)?.[0]).toBe("game-and-set");
    // The same in a tie-break at 6-1.
    const tb = play(games(initialScoreState("A"), "ABABABABABAB", bestOf3), "AAAAAAB", bestOf3);
    expect(callForTransition(tb, manualEndSet(tb, "A", bestOf3), POINT, bestOf3)?.[0]).toBe("set");
  });

  it("treats a point then its undo then another point as one point", () => {
    const from = initialScoreState("A");
    // The undo never reached past the last call (nothing had been said since love all).
    expect(callForTransition(from, play(from, "B"), { corrects: false, netPoints: 1 }, one)).toEqual(["pts-0-15"]);
  });

  it("reads the corrected order when the server was changed inside the window", () => {
    const from = initialScoreState("A");
    const to = changeServer(awardPoint(from, "A", one), "B");
    expect(callForTransition(from, to, POINT, one)).toEqual(["pts-0-15"]);
  });

  it("still calls the match when the result is confirmed inside the window", () => {
    const from = play(games(initialScoreState("A"), "AAAAA"), "AAA");
    const to = awardPoint(from, "A", one); // MATCH_ENDED carries the same state
    expect(sameScore(to, { ...to })).toBe(true);
    expect(callForTransition(from, to, POINT, one)).toEqual(["game-set-match"]);
  });
});

describe("other formats", () => {
  it("builds tallies past seven games in an advantage set", () => {
    const advantageSet = { ...one, tiebreakEnabled: false };
    const s = games(initialScoreState("A"), "ABABABABABABABA", advantageSet); // 8-7 to A, B to serve
    expect(gamesTally(s)).toEqual(["leads-receiver", "n-8", "games-to", "n-7"]);
    const level = games(s, "B", advantageSet);
    expect(gamesTally(level)).toEqual(["n-8", "games-all"]);
  });

  it("tallies sets in best of five", () => {
    const bestOf5 = { ...one, setsToWinMatch: 3 };
    let s = initialScoreState("A");
    s = games(s, "AAAAAA", bestOf5);
    s = games(s, "BBBBBB", bestOf5);
    expect(callForTransition(play(s, "BBB", bestOf5), s, { corrects: true, netPoints: -3 }, bestOf5)).not.toBeNull();
    const call = afterPoint(play(games(s, "BBBBB", bestOf5), "BBB", bestOf5), "B", bestOf5);
    expect(call?.[0]).toBe("game-and-set");
    expect(call).toContain("sets-2-1");
  });
});

describe("never throws and never asks for a missing clip", () => {
  /** A small deterministic generator, so the run is repeatable. */
  function lcg(seed: number) {
    let x = seed;
    return () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
  }

  const formats: ScoringConfig[] = [
    one,
    bestOf3,
    { ...one, setsToWinMatch: 3 },
    { ...bestOf3, tiebreakEnabled: false },
    { ...bestOf3, tiebreakTargetPoints: 10 },
    { ...bestOf3, tiebreakWinByTwo: false },
    { ...bestOf3, gamesToWinSet: 4, tiebreakAtGames: 4 },
  ];

  it("calls every point of random matches when the server is known", () => {
    formats.forEach((config, f) => {
      const rand = lcg(f + 7);
      for (let m = 0; m < 30; m++) {
        let s = initialScoreState(rand() < 0.5 ? "A" : "B");
        let guard = 0;
        while (!s.matchOver && guard++ < 2000) {
          const team: TeamKey = rand() < 0.5 ? "A" : "B";
          const next = awardPoint(s, team, config);
          const call = callForTransition(s, next, POINT, config);
          expect(call, `format ${f} match ${m}`).not.toBeNull();
          for (const id of call!) expect(PHRASES[id], id).toBeTruthy();
          // An undo of that point is always phrased too.
          const back = callForTransition(next, s, UNDO, config);
          if (!next.matchOver) {
            expect(back?.[0]).toBe("correction");
            for (const id of back!) expect(PHRASES[id], id).toBeTruthy();
          }
          s = next;
        }
        expect(s.matchOver).toBe(true);
      }
    });
  });
});

describe("calls with red and blue teams", () => {
  const NAMED = { corrects: false, netPoints: 1, named: true };
  const named = (from: ScoreState, team: TeamKey, config = one) =>
    callForTransition(from, awardPoint(from, team, config), NAMED, config);

  it("names the side with advantage", () => {
    const deuce = play(initialScoreState("A"), "AAABBB");
    expect(named(deuce, "A")).toEqual(["advantage", "team-red"]);
    expect(named(deuce, "B")).toEqual(["advantage", "team-blue", "break-point"]);
  });

  it("keeps plain point calls without names", () => {
    expect(named(initialScoreState("A"), "B")).toEqual(["pts-0-15"]);
  });

  it("names who won the game, then the leader after the tally", () => {
    // A holds the first game: "Game, A. One game to love, A."
    expect(named(play(initialScoreState("A"), "AAA"), "A")).toEqual(["game-named", "team-red", "games-1-0-named", "team-red"]);
    // B breaks back for 2-2: level games carry no name.
    expect(named(play(games(initialScoreState("A"), "ABA"), "BBB"), "B")).toEqual(["game-named", "team-blue", "games-all-2"]);
  });

  it("names the game winner when a tie-break starts", () => {
    const beforeTwelfth = play(games(initialScoreState("A"), "ABABABABABA"), "BBB");
    expect(named(beforeTwelfth, "B")).toEqual(["game-named", "team-blue", "games-all-6", "tie-break"]);
  });

  it("names the set winner and the sets leader", () => {
    const s = play(games(initialScoreState("A"), "AAAAA", bestOf3), "AAA", bestOf3);
    expect(named(s, "A", bestOf3)).toEqual(["game-and-set-named", "team-red", "sets-1-0-named", "team-red"]);
  });

  it("names the match winner", () => {
    const s = play(games(initialScoreState("A"), "AAAAA"), "AAA");
    expect(named(s, "A")).toEqual(["game-set-match-named", "team-red"]);
    const m = play(games(initialScoreState("A"), "BBBBB"), "BBB");
    expect(named(m, "B")).toEqual(["game-set-match-named", "team-blue"]);
  });

  it("names a set ended by hand", () => {
    const s = games(initialScoreState("A"), "AAAB", bestOf3);
    expect(callForTransition(s, manualEndSet(s, "A", bestOf3), NAMED, bestOf3)).toEqual(["set-named", "team-red", "sets-1-0-named", "team-red"]);
  });

  it("names the leader in a standing call and past seven games", () => {
    const from = initialScoreState("A");
    expect(callForTransition(from, play(from, "AAAAB"), { corrects: false, netPoints: 5, named: true }, one)).toEqual([
      "games-1-0-named",
      "team-red",
      "pts-15-0",
    ]);
    const advantageSet = { ...one, tiebreakEnabled: false };
    const s = games(initialScoreState("A"), "ABABABABABABABA", advantageSet); // 8-7 to A
    expect(gamesTally(s, true)).toEqual(["n-8", "games-to", "n-7", "team-red"]);
  });

  it("never asks for a clip that does not exist, in random named matches", () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (const config of [one, bestOf3, { ...bestOf3, tiebreakEnabled: false }, { ...one, setsToWinMatch: 3 }]) {
      for (let m = 0; m < 20; m++) {
        let s = initialScoreState(rand() < 0.5 ? "A" : "B");
        let guard = 0;
        while (!s.matchOver && guard++ < 2000) {
          const next = awardPoint(s, rand() < 0.5 ? "A" : "B", config);
          const call = callForTransition(s, next, NAMED, config);
          expect(call).not.toBeNull();
          for (const id of call!) expect(PHRASES[id], id).toBeTruthy();
          s = next;
        }
      }
    }
  });
});

describe("captions", () => {
  it("reads a call back as a sentence", () => {
    expect(captionFor(["game", "leads-server", "games-4-2"])).toBe("Game. Server leads four games to two.");
    expect(captionFor(TEST_CALL)).toBe("Fifteen love. Deuce. Advantage server.");
    expect(captionFor(["n-9", "all"])).toBe("Nine all");
    expect(captionFor(["game-named", "team-red", "games-4-2-named", "team-red"])).toBe("Game, Red team. Four games to two, Red team.");
    expect(captionFor(["advantage", "team-blue"])).toBe("Advantage, Blue team.");
    // Past seven games the tally is built from number words; the colour still reads as its own clause.
    expect(captionFor(["game-named", "team-red", "n-8", "games-to", "n-7", "team-red"])).toBe("Game, Red team. Eight games to seven, Red team.");
  });
});
