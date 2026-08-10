import { describe, it, expect } from "vitest";
import {
  applyResult,
  initialFireState,
  rebuildFromResults,
  resultKindFor,
  totalPoints,
  wouldCompleteStreakCap,
  wouldEarnFirePoint,
  wouldResetStreak,
  BASE_WIN_POINTS,
  MAX_FIRE_PER_STREAK,
  type FireResultInput,
  type FireState,
  type FriendlyResultKind,
} from "./fire";
import {
  generateAmericanoSchedule,
  generateFixedSchedule,
  loadSpread,
  nextMexicanoRound,
  pairQuad,
  partnerVariety,
  playerLoads,
  seededShuffle,
  validateSchedule,
  type FixedPair,
  type ScheduledRound,
} from "./scheduler";
import { estimateCapacity, defaultMatchMinutes } from "./capacity";
import { isSameMobile, maskMobile, normalizeMobile } from "./mobile";
import {
  buildRanking,
  rankPlayers,
  type LedgerEntry,
  type PlayerMatchStat,
} from "./ranking";

/* ------------------------------------------------------------------ */
/* Fire engine                                                         */
/* ------------------------------------------------------------------ */

/** Play a run of results and return the final state plus totals. */
function run(kinds: FriendlyResultKind[], from: FireState = initialFireState()) {
  let state = from;
  let base = 0;
  let fire = 0;
  for (const k of kinds) {
    const award = applyResult(state, k);
    state = award.state;
    base += award.basePoints;
    fire += award.firePoints;
  }
  return { state, base, fire };
}

describe("fire engine — streak awards", () => {
  it("wins 1-11 award 33 base points and exactly 10 fire points", () => {
    const { state, base, fire } = run(Array(11).fill("win"));
    expect(base).toBe(11 * BASE_WIN_POINTS);
    expect(fire).toBe(MAX_FIRE_PER_STREAK);
    expect(fire).toBe(10);
    expect(state.consecutiveWins).toBe(11);
    expect(state.totalFirePoints).toBe(10);
  });

  it("the first win of a streak earns no fire point", () => {
    const award = applyResult(initialFireState(), "win");
    expect(award.basePoints).toBe(3);
    expect(award.firePoints).toBe(0);
  });

  it("win 12 and beyond add base points but no further fire", () => {
    const after11 = run(Array(11).fill("win")).state;
    const twelfth = applyResult(after11, "win");
    expect(twelfth.basePoints).toBe(3);
    expect(twelfth.firePoints).toBe(0);
    expect(twelfth.state.totalFirePoints).toBe(10);

    const thirteenth = applyResult(twelfth.state, "win");
    expect(thirteenth.firePoints).toBe(0);
    expect(thirteenth.state.consecutiveWins).toBe(13);
  });

  it("each win from 2 to 11 awards exactly one fire point", () => {
    let state = initialFireState();
    const perWin: number[] = [];
    for (let i = 0; i < 12; i++) {
      const award = applyResult(state, "win");
      state = award.state;
      perWin.push(award.firePoints);
    }
    expect(perWin).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
  });
});

describe("fire engine — losses and resets", () => {
  it("a loss resets the active streak but keeps banked fire points", () => {
    const before = run(["win", "win", "win"]).state;
    expect(before.consecutiveWins).toBe(3);
    expect(before.totalFirePoints).toBe(2);

    const after = applyResult(before, "loss");
    expect(after.state.consecutiveWins).toBe(0);
    expect(after.state.totalFirePoints).toBe(2);
    expect(after.basePoints).toBe(0);
  });

  it("a later streak can bank another full 10 fire points", () => {
    let state = run(Array(11).fill("win")).state;
    state = applyResult(state, "loss").state;
    expect(state.totalFirePoints).toBe(10);

    const second = run(Array(11).fill("win"), state);
    expect(second.fire).toBe(10);
    expect(second.state.totalFirePoints).toBe(20);
  });

  it("a streak survives session and season boundaries — only a played loss breaks it", () => {
    // The engine has no notion of sessions; a continuous run of wins spanning
    // any number of sessions keeps accumulating, which is the locked rule.
    const sessionOne = run(["win", "win"]);
    const sessionTwo = run(["win", "win"], sessionOne.state);
    const seasonTwo = run(["win"], sessionTwo.state);
    expect(seasonTwo.state.consecutiveWins).toBe(5);
    expect(seasonTwo.state.totalFirePoints).toBe(4);
  });
});

describe("fire engine — walkovers and voids", () => {
  it("a walkover win pays base points but freezes the streak", () => {
    const before = run(["win", "win", "win", "win"]).state;
    expect(before.consecutiveWins).toBe(4);

    const wo = applyResult(before, "walkover_win");
    expect(wo.basePoints).toBe(3);
    expect(wo.firePoints).toBe(0);
    expect(wo.state.consecutiveWins).toBe(4); // frozen, not advanced

    // The next played win continues from where the player was: win #5.
    const next = applyResult(wo.state, "win");
    expect(next.state.consecutiveWins).toBe(5);
    expect(next.firePoints).toBe(1);
  });

  it("a walkover loss resets the absent player's streak", () => {
    const before = run(["win", "win", "win"]).state;
    const after = applyResult(before, "walkover_loss");
    expect(after.state.consecutiveWins).toBe(0);
    expect(after.state.totalFirePoints).toBe(2);
    expect(after.basePoints).toBe(0);
  });

  it("a void match changes nothing at all", () => {
    const before = run(["win", "win"]).state;
    const after = applyResult(before, "void");
    expect(after.state).toEqual(before);
    expect(after.basePoints).toBe(0);
    expect(after.firePoints).toBe(0);
  });
});

describe("fire engine — predicate helpers", () => {
  it("wouldEarnFirePoint is false on the first win and true on the second", () => {
    const start = initialFireState();
    expect(wouldEarnFirePoint(start, "win")).toBe(false);
    const afterOne = applyResult(start, "win").state;
    expect(wouldEarnFirePoint(afterOne, "win")).toBe(true);
  });

  it("wouldResetStreak only fires when there is a streak to lose", () => {
    const start = initialFireState();
    expect(wouldResetStreak(start, "loss")).toBe(false);
    const onThree = run(["win", "win", "win"]).state;
    expect(wouldResetStreak(onThree, "loss")).toBe(true);
    expect(wouldResetStreak(onThree, "walkover_loss")).toBe(true);
    expect(wouldResetStreak(onThree, "walkover_win")).toBe(false);
    expect(wouldResetStreak(onThree, "void")).toBe(false);
  });

  it("wouldCompleteStreakCap flags the 11th win only", () => {
    const onNine = run(Array(9).fill("win")).state;
    expect(wouldCompleteStreakCap(onNine, "win")).toBe(false);
    const onTen = applyResult(onNine, "win").state;
    expect(wouldCompleteStreakCap(onTen, "win")).toBe(true);
  });
});

describe("fire engine — replay for corrections and merges", () => {
  const results = (kinds: FriendlyResultKind[]): FireResultInput[] =>
    kinds.map((kind, i) => ({ matchId: `m${i + 1}`, kind }));

  it("replaying a history reproduces the incremental result exactly", () => {
    const kinds: FriendlyResultKind[] = ["win", "win", "loss", "win", "win", "win"];
    const incremental = run(kinds);
    const replay = rebuildFromResults(results(kinds));
    expect(replay.state).toEqual(incremental.state);
    expect(totalPoints(replay.awards)).toBe(incremental.base + incremental.fire);
  });

  it("replay is idempotent — running it twice gives the same answer", () => {
    const input = results(["win", "win", "win", "loss", "win"]);
    const first = rebuildFromResults(input);
    const second = rebuildFromResults(input);
    expect(second).toEqual(first);
  });

  it("correcting an early result rebuilds every later fire award without duplicates", () => {
    // Original: W W W W  → 3 fire points banked.
    const original = rebuildFromResults(results(["win", "win", "win", "win"]));
    expect(original.state.totalFirePoints).toBe(3);
    expect(original.awards).toHaveLength(4);

    // Match 2 is corrected to a loss. Everything after it must be recomputed:
    // W L W W → the streak restarts, so only the final win earns fire.
    const corrected = rebuildFromResults(results(["win", "loss", "win", "win"]));
    expect(corrected.state.totalFirePoints).toBe(1);
    expect(corrected.state.consecutiveWins).toBe(2);
    // One award row per match — a rebuild replaces, never appends.
    expect(corrected.awards).toHaveLength(4);
    expect(corrected.awards.map((a) => a.matchId)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(corrected.awards.map((a) => a.firePoints)).toEqual([0, 0, 0, 1]);
  });

  it("a merged profile replays the union of both histories in order", () => {
    // Two duplicate profiles, each with wins that never earned much alone.
    const profileA: FireResultInput[] = [
      { matchId: "a1", kind: "win" },
      { matchId: "a2", kind: "win" },
    ];
    const profileB: FireResultInput[] = [
      { matchId: "b1", kind: "win" },
      { matchId: "b2", kind: "win" },
    ];
    expect(rebuildFromResults(profileA).state.totalFirePoints).toBe(1);
    expect(rebuildFromResults(profileB).state.totalFirePoints).toBe(1);

    // Merged in authoritative order they form one 4-win streak worth 3 fire —
    // not the 2 they had as separate profiles, and crucially not double-counted.
    const merged = rebuildFromResults([...profileA, ...profileB]);
    expect(merged.state.consecutiveWins).toBe(4);
    expect(merged.state.totalFirePoints).toBe(3);
    expect(merged.awards).toHaveLength(4);
  });

  it("a partner change does not touch individual streaks", () => {
    // Streaks are per-player; the engine never sees a partner at all. A player
    // whose partner changes mid-session keeps their run going.
    const beforeSwap = run(["win", "win"]).state;
    const afterSwap = run(["win"], beforeSwap);
    expect(afterSwap.state.consecutiveWins).toBe(3);
    expect(afterSwap.state.totalFirePoints).toBe(2);
  });
});

describe("fire engine — result kind derivation", () => {
  it("maps match statuses to the right result kind for each side", () => {
    expect(resultKindFor("completed", true)).toBe("win");
    expect(resultKindFor("completed", false)).toBe("loss");
    expect(resultKindFor("retired", true)).toBe("win");
    expect(resultKindFor("retired", false)).toBe("loss");
    expect(resultKindFor("walkover", true)).toBe("walkover_win");
    expect(resultKindFor("walkover", false)).toBe("walkover_loss");
    expect(resultKindFor("disqualified", true)).toBe("walkover_win");
    expect(resultKindFor("disqualified", false)).toBe("walkover_loss");
    expect(resultKindFor("cancelled", true)).toBe("void");
  });

  it("an unfinished status is treated as void, never as a result", () => {
    for (const status of ["scheduled", "live", "paused", "pending_sync"]) {
      expect(resultKindFor(status, true)).toBe("void");
      expect(resultKindFor(status, false)).toBe("void");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

const players = (n: number) =>
  Array.from({ length: n }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);

/** No player may appear on two courts in the same round. */
function assertNoOverlap(rounds: ScheduledRound[], courts: number) {
  expect(validateSchedule(rounds, courts)).toEqual([]);
}

describe("scheduler — fixed partners", () => {
  const pairs = (n: number): FixedPair[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `pair${i + 1}`,
      players: [`p${i + 1}a`, `p${i + 1}b`] as [string, string],
    }));

  it("every pair meets every other pair once", () => {
    const rounds = generateFixedSchedule(pairs(4), { courts: 2 });
    const all = rounds.flatMap((r) => r.matches);
    expect(all).toHaveLength(6); // C(4,2)
    const seen = new Set(
      all.map((m) => [m.teamA.join(), m.teamB.join()].sort().join("~"))
    );
    expect(seen.size).toBe(6);
  });

  it("never puts a player on two courts at once", () => {
    for (const n of [3, 4, 5, 6, 8]) {
      const rounds = generateFixedSchedule(pairs(n), { courts: 3 });
      assertNoOverlap(rounds, 3);
    }
  });

  it("respects the court limit even when more pairings are ready", () => {
    const rounds = generateFixedSchedule(pairs(8), { courts: 2 });
    for (const r of rounds) expect(r.matches.length).toBeLessThanOrEqual(2);
  });

  it("honours maxRounds from the capacity estimate", () => {
    const rounds = generateFixedSchedule(pairs(6), { courts: 3, maxRounds: 2 });
    expect(rounds).toHaveLength(2);
  });

  it("reports resting pairs' players", () => {
    const rounds = generateFixedSchedule(pairs(4), { courts: 1 });
    // One court means one match per round, so two pairs rest each round.
    for (const r of rounds) {
      expect(r.matches).toHaveLength(1);
      expect(r.resting).toHaveLength(4);
    }
  });

  it("returns nothing when there are too few pairs or no courts", () => {
    expect(generateFixedSchedule(pairs(1), { courts: 2 })).toEqual([]);
    expect(generateFixedSchedule(pairs(4), { courts: 0 })).toEqual([]);
  });
});

describe("scheduler — americano", () => {
  it("never puts a player on two courts in one round", () => {
    for (const n of [8, 12, 16]) {
      const rounds = generateAmericanoSchedule(players(n), { courts: 4, rounds: 6 });
      assertNoOverlap(rounds, 4);
    }
  });

  it("keeps matches played within one of each other", () => {
    const rounds = generateAmericanoSchedule(players(12), { courts: 3, rounds: 8 });
    expect(loadSpread(rounds)).toBeLessThanOrEqual(1);
  });

  it("balances rest turns when the player count is not a multiple of four", () => {
    // 10 players on 2 courts: 8 play, 2 rest every round.
    const rounds = generateAmericanoSchedule(players(10), { courts: 2, rounds: 10 });
    for (const r of rounds) {
      expect(r.matches).toHaveLength(2);
      expect(r.resting).toHaveLength(2);
    }
    const loads = playerLoads(rounds);
    const rests = loads.map((l) => l.rested);
    expect(Math.max(...rests) - Math.min(...rests)).toBeLessThanOrEqual(1);
  });

  it("rotates partners rather than repeating them", () => {
    const rounds = generateAmericanoSchedule(players(8), { courts: 2, rounds: 5 });
    const variety = partnerVariety(rounds);
    // Over 5 rounds each player partners 5 times; a good rotation should give
    // them several distinct partners rather than the same one repeatedly.
    for (const count of variety.values()) {
      expect(count).toBeGreaterThanOrEqual(4);
    }
  });

  it("is deterministic for the same input", () => {
    const a = generateAmericanoSchedule(players(12), { courts: 3, rounds: 5 });
    const b = generateAmericanoSchedule(players(12), { courts: 3, rounds: 5 });
    expect(b).toEqual(a);
  });

  it("is limited by courts, not just players", () => {
    const rounds = generateAmericanoSchedule(players(16), { courts: 2, rounds: 4 });
    for (const r of rounds) {
      expect(r.matches).toHaveLength(2);
      expect(r.resting).toHaveLength(8);
    }
  });

  it("returns nothing when fewer than four players are available", () => {
    expect(generateAmericanoSchedule(players(3), { courts: 2, rounds: 4 })).toEqual([]);
  });
});

describe("scheduler — mexicano", () => {
  const standings = (ids: string[]) =>
    ids.map((playerProfileId, i) => ({
      playerProfileId,
      points: 100 - i, // already in rank order
      gameDiff: 0,
    }));

  it("pairs 1st+4th against 2nd+3rd on each court", () => {
    const round = nextMexicanoRound(standings(players(8)), 2, { courts: 2 });
    expect(round.matches).toHaveLength(2);
    const top = round.matches[0];
    expect(top.teamA).toEqual(["p01", "p04"]);
    expect(top.teamB).toEqual(["p02", "p03"]);
    const second = round.matches[1];
    expect(second.teamA).toEqual(["p05", "p08"]);
    expect(second.teamB).toEqual(["p06", "p07"]);
  });

  it("puts the strongest players on the first court", () => {
    const round = nextMexicanoRound(standings(players(12)), 4, { courts: 3 });
    const courtOne = [...round.matches[0].teamA, ...round.matches[0].teamB].sort();
    expect(courtOne).toEqual(["p01", "p02", "p03", "p04"]);
  });

  it("ranks by points then game difference", () => {
    const s = [
      { playerProfileId: "low", points: 3, gameDiff: 10 },
      { playerProfileId: "tieA", points: 9, gameDiff: 2 },
      { playerProfileId: "tieB", points: 9, gameDiff: 8 },
      { playerProfileId: "top", points: 12, gameDiff: 0 },
    ];
    const round = nextMexicanoRound(s, 2, { courts: 1 });
    // Order should be top(12), tieB(9,+8), tieA(9,+2), low(3) → 1st+4th vs 2nd+3rd
    expect(round.matches[0].teamA).toEqual(["top", "low"]);
    expect(round.matches[0].teamB).toEqual(["tieB", "tieA"]);
  });

  it("draws round 1 at random rather than by id order", () => {
    // Everyone on zero: a rank sort would fall through to a deterministic id
    // sort and give the same 'random' draw every event.
    const zeroed = players(8).map((playerProfileId) => ({
      playerProfileId,
      points: 0,
      gameDiff: 0,
    }));
    const seedA = nextMexicanoRound(zeroed, 1, { courts: 2, drawSeed: 12345 });
    const seedB = nextMexicanoRound(zeroed, 1, { courts: 2, drawSeed: 99999 });
    const flat = (r: ScheduledRound) => r.matches.flatMap((m) => [...m.teamA, ...m.teamB]);
    expect(flat(seedA)).not.toEqual(flat(seedB));
    // Still a valid round: everyone placed exactly once.
    expect(new Set(flat(seedA)).size).toBe(8);
    assertNoOverlap([seedA], 2);
  });

  it("reproduces the same round 1 draw for the same seed", () => {
    const zeroed = players(12).map((playerProfileId) => ({
      playerProfileId,
      points: 0,
      gameDiff: 0,
    }));
    const first = nextMexicanoRound(zeroed, 1, { courts: 3, drawSeed: 4242 });
    const again = nextMexicanoRound(zeroed, 1, { courts: 3, drawSeed: 4242 });
    expect(again).toEqual(first);
  });

  it("seededShuffle is a deterministic permutation", () => {
    const input = players(10);
    const a = seededShuffle(input, 7);
    const b = seededShuffle(input, 7);
    const c = seededShuffle(input, 8);
    expect(a).toEqual(b); // same seed → same order
    expect(a).not.toEqual(c); // different seed → different order
    expect([...a].sort()).toEqual([...input].sort()); // permutation, nothing lost
    expect(input).toEqual(players(10)); // input untouched
  });

  it("supports all three within-court pairing conventions", () => {
    const quad = ["r1", "r2", "r3", "r4"];
    expect(pairQuad(quad, "balanced_1_4")).toEqual({
      teamA: ["r1", "r4"],
      teamB: ["r2", "r3"],
    });
    expect(pairQuad(quad, "semi_1_3")).toEqual({
      teamA: ["r1", "r3"],
      teamB: ["r2", "r4"],
    });
    expect(pairQuad(quad, "top_heavy_1_2")).toEqual({
      teamA: ["r1", "r2"],
      teamB: ["r3", "r4"],
    });
  });

  it("applies the chosen convention when building a round", () => {
    const round = nextMexicanoRound(standings(players(4)), 2, {
      courts: 1,
      convention: "top_heavy_1_2",
    });
    expect(round.matches[0].teamA).toEqual(["p01", "p02"]);
    expect(round.matches[0].teamB).toEqual(["p03", "p04"]);
  });

  it("never overlaps players and respects courts", () => {
    const round = nextMexicanoRound(standings(players(16)), 3, { courts: 3 });
    assertNoOverlap([round], 3);
    expect(round.matches).toHaveLength(3);
    expect(round.resting).toHaveLength(4);
  });

  it("rests the players who have rested least so far", () => {
    const rests = new Map([
      ["p01", 2],
      ["p02", 0],
      ["p03", 2],
      ["p04", 2],
      ["p05", 2],
    ]);
    // 5 players, 1 court → 4 play, 1 rests. p02 has rested least.
    const round = nextMexicanoRound(standings(players(5)), 4, { courts: 1 }, rests);
    expect(round.resting).toEqual(["p02"]);
  });

  it("produces no matches when there are fewer than four players", () => {
    const round = nextMexicanoRound(standings(players(3)), 1, { courts: 2 });
    expect(round.matches).toEqual([]);
    expect(round.resting).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

describe("capacity estimator", () => {
  it("fits four rounds of one-set matches into a two-hour session", () => {
    const est = estimateCapacity({
      durationMinutes: 120,
      expectedMatchMinutes: 30,
      turnoverMinutes: 5,
      courts: 2,
      playerCount: 8,
    });
    expect(est.roundsThatFit).toBe(3); // 35-minute slots
    expect(est.matchesPerRound).toBe(2);
    expect(est.totalMatches).toBe(6);
    expect(est.matchesPerPlayer).toBe(3);
    expect(est.evenlyBalanced).toBe(true);
  });

  it("fits fewer rounds for best-of-three", () => {
    const oneSet = estimateCapacity({
      durationMinutes: 120,
      expectedMatchMinutes: defaultMatchMinutes(1),
      turnoverMinutes: 5,
      courts: 2,
      playerCount: 8,
    });
    const bestOfThree = estimateCapacity({
      durationMinutes: 120,
      expectedMatchMinutes: defaultMatchMinutes(2),
      turnoverMinutes: 5,
      courts: 2,
      playerCount: 8,
    });
    expect(bestOfThree.roundsThatFit).toBeLessThan(oneSet.roundsThatFit);
    expect(bestOfThree.roundsThatFit).toBe(1);
  });

  it("warns when players are not a multiple of four", () => {
    const est = estimateCapacity({
      durationMinutes: 120,
      expectedMatchMinutes: 30,
      turnoverMinutes: 5,
      courts: 2,
      playerCount: 10,
    });
    expect(est.warnings.join(" ")).toContain("not a multiple of 4");
  });

  it("warns when there are too few players to fill the courts", () => {
    const est = estimateCapacity({
      durationMinutes: 120,
      expectedMatchMinutes: 30,
      turnoverMinutes: 5,
      courts: 4,
      playerCount: 8,
    });
    expect(est.matchesPerRound).toBe(2);
    expect(est.warnings.join(" ")).toContain("of 4 courts");
  });

  it("warns when a match cannot fit in the window at all", () => {
    const est = estimateCapacity({
      durationMinutes: 20,
      expectedMatchMinutes: 60,
      turnoverMinutes: 5,
      courts: 1,
      playerCount: 4,
    });
    expect(est.roundsThatFit).toBe(0);
    expect(est.warnings.join(" ")).toContain("does not fit");
  });

  it("warns when there are not enough players for a single match", () => {
    const est = estimateCapacity({
      durationMinutes: 120,
      expectedMatchMinutes: 30,
      turnoverMinutes: 5,
      courts: 1,
      playerCount: 3,
    });
    expect(est.matchesPerRound).toBe(0);
    expect(est.warnings.join(" ")).toContain("At least 4");
  });
});

/* ------------------------------------------------------------------ */
/* Mobile normalisation — the player identity key                      */
/* ------------------------------------------------------------------ */

describe("mobile normalisation", () => {
  it("collapses the ways one Egyptian number gets typed onto one identity", () => {
    const forms = [
      "01001234567",
      "0100 123 4567",
      "+201001234567",
      "+20 100 123 4567",
      "00201001234567",
      "1001234567",
      "(0100) 123-4567",
    ];
    const normalised = forms.map((f) => normalizeMobile(f));
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe("+201001234567");
  });

  it("keeps genuinely different numbers apart", () => {
    expect(isSameMobile("01001234567", "01001234568")).toBe(false);
    expect(isSameMobile("01001234567", "01001234567")).toBe(true);
  });

  it("respects an explicit international number from another country", () => {
    expect(normalizeMobile("+447700900123")).toBe("+447700900123");
    expect(normalizeMobile("00447700900123")).toBe("+447700900123");
  });

  it("converts Arabic-Indic digits", () => {
    expect(normalizeMobile("٠١٠٠١٢٣٤٥٦٧")).toBe("+201001234567");
  });

  it("rejects input it cannot interpret rather than storing something wrong", () => {
    for (const bad of ["", "   ", "abc", "12", "+", "-", "12345678901234567890"]) {
      expect(normalizeMobile(bad)).toBeNull();
    }
  });

  it("masks numbers for incidental display", () => {
    expect(maskMobile("+201001234567")).toBe("+201•••567");
    expect(maskMobile(null)).toBe("—");
  });
});

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

describe("ranking", () => {
  const base = (
    playerProfileId: string,
    matchId: string,
    points: number,
    sessionId = "s1",
    seasonId: string | null = "y1"
  ): LedgerEntry => ({
    playerProfileId,
    matchId,
    component: "base_win",
    points,
    source: "friendly",
    status: "official",
    sessionId,
    seasonId,
  });

  const fire = (
    playerProfileId: string,
    matchId: string,
    sessionId = "s1",
    seasonId: string | null = "y1"
  ): LedgerEntry => ({
    playerProfileId,
    matchId,
    component: "fire",
    points: 1,
    source: "friendly",
    status: "official",
    sessionId,
    seasonId,
  });

  const stat = (
    playerProfileId: string,
    matchId: string,
    won: boolean,
    gamesWon: number,
    gamesLost: number,
    sessionId = "s1",
    seasonId: string | null = "y1"
  ): PlayerMatchStat => ({
    playerProfileId,
    matchId,
    won,
    gamesWon,
    gamesLost,
    sessionId,
    seasonId,
  });

  it("totals base and fire points per player", () => {
    const lines = buildRanking(
      [base("a", "m1", 3), fire("a", "m2"), base("a", "m2", 3), base("b", "m1", 3)],
      [stat("a", "m1", true, 6, 2), stat("a", "m2", true, 6, 1), stat("b", "m1", false, 2, 6)],
      { scope: { kind: "session", sessionId: "s1" }, officialOnly: true }
    );
    const a = lines.find((l) => l.playerProfileId === "a")!;
    expect(a.basePoints).toBe(6);
    expect(a.firePoints).toBe(1);
    expect(a.totalPoints).toBe(7);
    expect(a.rank).toBe(1);
    expect(a.matchesPlayed).toBe(2);
    expect(a.wins).toBe(2);
  });

  it("shows players with no points but a played match", () => {
    const lines = buildRanking([], [stat("loser", "m1", false, 1, 6)], {
      scope: { kind: "session", sessionId: "s1" },
      officialOnly: true,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].totalPoints).toBe(0);
    expect(lines[0].losses).toBe(1);
    expect(lines[0].matchesPlayed).toBe(1);
  });

  it("ranks by points, then wins, then game diff, then games won", () => {
    const lines = rankPlayers([
      { playerProfileId: "d", basePoints: 3, firePoints: 0, gamePoints: 0, wins: 1, losses: 1, gamesWon: 8, gamesLost: 8, matchesPlayed: 2 },
      { playerProfileId: "c", basePoints: 3, firePoints: 0, gamePoints: 0, wins: 1, losses: 1, gamesWon: 9, gamesLost: 9, matchesPlayed: 2 },
      { playerProfileId: "b", basePoints: 6, firePoints: 0, gamePoints: 0, wins: 2, losses: 0, gamesWon: 12, gamesLost: 4, matchesPlayed: 2 },
      { playerProfileId: "a", basePoints: 6, firePoints: 1, gamePoints: 0, wins: 2, losses: 0, gamesWon: 12, gamesLost: 3, matchesPlayed: 2 },
    ]);
    expect(lines.map((l) => l.playerProfileId)).toEqual(["a", "b", "c", "d"]);
    // c and d tie on points and wins and game diff (0); c wins on games won.
    expect(lines[2].playerProfileId).toBe("c");
  });

  it("gives tied players the same rank and skips the next", () => {
    const lines = rankPlayers([
      { playerProfileId: "x", basePoints: 3, firePoints: 0, gamePoints: 0, wins: 1, losses: 0, gamesWon: 6, gamesLost: 2, matchesPlayed: 1 },
      { playerProfileId: "y", basePoints: 3, firePoints: 0, gamePoints: 0, wins: 1, losses: 0, gamesWon: 6, gamesLost: 2, matchesPlayed: 1 },
      { playerProfileId: "z", basePoints: 0, firePoints: 0, gamePoints: 0, wins: 0, losses: 1, gamesWon: 2, gamesLost: 6, matchesPlayed: 1 },
    ]);
    expect(lines[0].rank).toBe(1);
    expect(lines[1].rank).toBe(1);
    expect(lines[2].rank).toBe(3);
  });

  it("filters provisional rows out of official rankings but keeps them live", () => {
    const provisional: LedgerEntry = { ...base("a", "m9", 3), status: "provisional" };
    const official = buildRanking([base("a", "m1", 3), provisional], [], {
      scope: { kind: "session", sessionId: "s1" },
      officialOnly: true,
    });
    expect(official[0].totalPoints).toBe(3);

    const live = buildRanking([base("a", "m1", 3), provisional], [], {
      scope: { kind: "session", sessionId: "s1" },
      officialOnly: false,
    });
    expect(live[0].totalPoints).toBe(6);
  });

  it("scopes to a session, a season, or lifetime", () => {
    const ledger = [
      base("a", "m1", 3, "s1", "y1"),
      base("a", "m2", 3, "s2", "y1"),
      base("a", "m3", 3, "s3", "y2"),
    ];
    const session = buildRanking(ledger, [], {
      scope: { kind: "session", sessionId: "s1" },
      officialOnly: true,
    });
    expect(session[0].totalPoints).toBe(3);

    const season = buildRanking(ledger, [], {
      scope: { kind: "season", seasonId: "y1" },
      officialOnly: true,
    });
    expect(season[0].totalPoints).toBe(6);

    const lifetime = buildRanking(ledger, [], {
      scope: { kind: "lifetime" },
      officialOnly: true,
    });
    expect(lifetime[0].totalPoints).toBe(9);
  });

  it("excludes tournament-sourced rows unless explicitly asked for", () => {
    const ledger: LedgerEntry[] = [
      base("a", "m1", 3),
      { ...base("a", "m2", 3), source: "tournament" },
    ];
    const friendlyOnly = buildRanking(ledger, [], {
      scope: { kind: "lifetime" },
      officialOnly: true,
    });
    expect(friendlyOnly[0].totalPoints).toBe(3);

    const both = buildRanking(ledger, [], {
      scope: { kind: "lifetime" },
      officialOnly: true,
      sources: ["friendly", "tournament"],
    });
    expect(both[0].totalPoints).toBe(6);
  });

  it("carries matches played so unequal schedules are visible", () => {
    const lines = buildRanking(
      [base("busy", "m1", 3), base("busy", "m2", 3), base("rested", "m3", 3)],
      [
        stat("busy", "m1", true, 6, 0),
        stat("busy", "m2", true, 6, 0),
        stat("rested", "m3", true, 6, 0),
      ],
      { scope: { kind: "session", sessionId: "s1" }, officialOnly: true }
    );
    expect(lines[0].playerProfileId).toBe("busy");
    expect(lines[0].matchesPlayed).toBe(2);
    expect(lines[1].matchesPlayed).toBe(1);
  });

  it("banks games under the games_won model — losers keep their games", () => {
    // A 6-4 set: winners bank 6 each, losers bank 4 each. The loser scoring
    // at all is the whole point of the model.
    const gamesRow = (playerProfileId: string, matchId: string, points: number): LedgerEntry => ({
      playerProfileId,
      matchId,
      component: "games",
      points,
      source: "friendly",
      status: "official",
      sessionId: "s1",
      seasonId: "y1",
    });
    const lines = buildRanking(
      [gamesRow("winner", "m1", 6), gamesRow("loser", "m1", 4)],
      [stat("winner", "m1", true, 6, 4), stat("loser", "m1", false, 4, 6)],
      { scope: { kind: "session", sessionId: "s1" }, officialOnly: true }
    );
    const w = lines.find((l) => l.playerProfileId === "winner")!;
    const l = lines.find((l) => l.playerProfileId === "loser")!;
    expect(w.gamePoints).toBe(6);
    expect(w.totalPoints).toBe(6);
    expect(l.gamePoints).toBe(4);
    expect(l.totalPoints).toBe(4);
    expect(w.rank).toBe(1);
    expect(l.rank).toBe(2);
  });

  it("adds fire on top of banked games — fire applies in both models", () => {
    const lines = buildRanking(
      [
        { playerProfileId: "a", matchId: "m1", component: "games", points: 6, source: "friendly", status: "official", sessionId: "s1", seasonId: "y1" },
        fire("a", "m1"),
      ],
      [stat("a", "m1", true, 6, 2)],
      { scope: { kind: "session", sessionId: "s1" }, officialOnly: true }
    );
    expect(lines[0].gamePoints).toBe(6);
    expect(lines[0].firePoints).toBe(1);
    expect(lines[0].totalPoints).toBe(7);
  });

  it("attaches the active streak for display", () => {
    const lines = buildRanking([base("a", "m1", 3)], [], {
      scope: { kind: "lifetime" },
      officialOnly: true,
      activeStreaks: new Map([["a", 7]]),
    });
    expect(lines[0].activeStreak).toBe(7);
  });
});
