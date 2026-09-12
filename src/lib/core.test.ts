import { describe, it, expect } from "vitest";
import { roundRobin, matchesPerGroup } from "./roundrobin";
import { groupSizes, generateDraw, generateDrawOptions } from "./draws";
import {
  buildBracketPlan,
  advanceTarget,
  orderKnockoutMatches,
  orderedRoundNames,
  podiumDepthFor,
  roundNameForSize,
  roundSequence,
  thirdPlaceFor,
  tierSizes,
  validatePodiumSettings,
  type Qualifier,
} from "./bracket";
import { parseTeamsCsv, CSV_TEMPLATE } from "./csv";
import { calculateStandings, applyQualification } from "./standings";
import type { Match, MatchSnapshot } from "./types";

describe("roundRobin", () => {
  it("generates n(n-1)/2 matches", () => {
    for (const n of [3, 4, 5, 6]) {
      const teams = Array.from({ length: n }, (_, i) => `t${i}`);
      expect(roundRobin(teams)).toHaveLength(matchesPerGroup(n));
    }
  });

  it("3 teams → 3 rounds with one resting team each", () => {
    const pairs = roundRobin(["a", "b", "c"]);
    expect(pairs).toHaveLength(3);
    expect(new Set(pairs.map((p) => p.round)).size).toBe(3);
  });

  it("no team plays twice in one round", () => {
    const pairs = roundRobin(["a", "b", "c", "d", "e", "f"]);
    const byRound = new Map<number, string[]>();
    for (const p of pairs) {
      const arr = byRound.get(p.round) ?? [];
      arr.push(p.teamA, p.teamB);
      byRound.set(p.round, arr);
    }
    for (const teams of byRound.values()) {
      expect(new Set(teams).size).toBe(teams.length);
    }
  });
});

describe("draws", () => {
  it("10 teams into 3 groups → 4/3/3", () => {
    expect(groupSizes(10, 3)).toEqual([4, 3, 3]);
  });

  it("respects locked teams", () => {
    const teams = Array.from({ length: 9 }, (_, i) => `t${i}`);
    const draw = generateDraw(teams, 3, { t0: 2, t1: 2 });
    expect(draw.groups[2]).toContain("t0");
    expect(draw.groups[2]).toContain("t1");
    expect(draw.groups.flat().sort()).toEqual([...teams].sort());
  });

  it("generates multiple distinct options", () => {
    const teams = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const options = generateDrawOptions(teams, 4, {}, 5);
    expect(options.length).toBeGreaterThanOrEqual(2);
  });
});

describe("bracket", () => {
  const q8 = [0, 1, 2, 3].flatMap((g) => [
    { teamId: `g${g}r1`, groupOrder: g, rank: 1 },
    { teamId: `g${g}r2`, groupOrder: g, rank: 2 },
  ]);

  it("8 qualifiers from 4 groups → spec §16.2 cross pairing", () => {
    const plan = buildBracketPlan(q8, true);
    const qf = plan.find((r) => r.roundName === "QF")!;
    const teams = qf.slots.map((s) => s.teamId);
    // Physical order: A1-B2, C1-D2, B1-A2, D1-C2
    expect(teams).toEqual(["g0r1", "g1r2", "g2r1", "g3r2", "g1r1", "g0r2", "g3r1", "g2r2"]);
    expect(plan.map((r) => r.roundName)).toEqual(["QF", "SF", "F", "TP"]);
  });

  it("6 qualifiers → 8-bracket with 2 byes for top seeds", () => {
    const q6 = q8.filter((q) => !["g2r2", "g3r2"].includes(q.teamId));
    const plan = buildBracketPlan(q6, false);
    const qf = plan.find((r) => r.roundName === "QF")!;
    expect(qf.slots.filter((s) => s.isBye)).toHaveLength(2);
    expect(qf.slots.filter((s) => s.teamId)).toHaveLength(6);
  });

  it("advancement targets", () => {
    expect(advanceTarget("QF", 3)).toEqual({ roundName: "SF", slotOrder: 3 });
    expect(advanceTarget("SF", 0)).toEqual({ roundName: "F", slotOrder: 0 });
    expect(advanceTarget("F", 0)).toBeNull();
    expect(roundNameForSize(16)).toBe("R16");
  });
});

describe("csv", () => {
  it("parses the template", () => {
    const rows = parseTeamsCsv(CSV_TEMPLATE);
    expect(rows).toHaveLength(2);
    expect(rows[0].team_name).toBe("Team Alpha");
    expect(rows[0].errors).toHaveLength(0);
  });

  it("blocks rows missing required fields and drops bad photo urls", () => {
    const rows = parseTeamsCsv(
      "team_name,player_1_name,player_2_name,player_1_photo_url\nTeam X,,Bob,notaurl"
    );
    expect(rows[0].errors).toContain("player_1_name is required");
    expect(rows[0].player_1_photo_url).toBe("");
  });
});

describe("standings", () => {
  function finishedMatch(id: string, a: string, b: string, winner: string, gamesA: number, gamesB: number) {
    const match = {
      id,
      tournament_id: "t",
      stage: "group",
      group_id: "g",
      team_a_id: a,
      team_b_id: b,
      status: "completed",
      winner_team_id: winner,
    } as unknown as Match;
    const snapshot = {
      match_id: id,
      team_a_sets: winner === a ? 1 : 0,
      team_b_sets: winner === b ? 1 : 0,
      team_a_games: 0,
      team_b_games: 0,
      completed_sets: [{ teamAGames: gamesA, teamBGames: gamesB }],
    } as unknown as MatchSnapshot;
    return { match, snapshot };
  }

  it("ranks by points then head-to-head", () => {
    // t1 beats t2, t2 beats t3, t3 beats t1 — 3-way tie broken by game diff
    const results = [
      finishedMatch("m1", "t1", "t2", "t1", 6, 3),
      finishedMatch("m2", "t2", "t3", "t2", 6, 4),
      finishedMatch("m3", "t3", "t1", "t3", 6, 0),
    ];
    const standings = calculateStandings("t", "g", ["t1", "t2", "t3"], results, new Set());
    expect(standings.map((s) => s.points)).toEqual([1, 1, 1]);
    // game diffs: t1 = 6-3 + 0-6 = -3; t2 = 3-6 + 6-4 = -1; t3 = 4-6 + 6-0 = +4
    expect(standings.map((s) => s.team_id)).toEqual(["t3", "t2", "t1"]);
  });

  it("two-way ties use head-to-head before game diff", () => {
    // t1 and t2 both have 1 win; t2 has the better game diff (+4 vs +2)
    // but t1 won the head-to-head, so t1 ranks above t2.
    const results = [
      finishedMatch("m1", "t1", "t2", "t1", 6, 4),
      finishedMatch("m2", "t2", "t3", "t2", 6, 0),
    ];
    const standings = calculateStandings("t", "g", ["t1", "t2", "t3"], results, new Set());
    const t1 = standings.find((s) => s.team_id === "t1")!;
    const t2 = standings.find((s) => s.team_id === "t2")!;
    expect(t1.rank).toBe(1);
    expect(t2.rank).toBe(2);
  });

  it("walkover applies default 6-0 and qualification statuses apply", () => {
    const wo = finishedMatch("m1", "t1", "t2", "t1", 0, 0);
    wo.match.status = "walkover";
    wo.snapshot = null as unknown as MatchSnapshot;
    const standings = calculateStandings("t", "g", ["t1", "t2"], [{ match: wo.match, snapshot: null }], new Set());
    expect(standings[0].games_won).toBe(6);
    applyQualification(standings, 1, true);
    expect(standings[0].status).toBe("qualified");
    expect(standings[1].status).toBe("eliminated");
  });
});

describe("orderedRoundNames", () => {
  it("puts rounds in the order they are played", () => {
    // getBracketSlots sorts by slot_order alone and every round has a slot 0,
    // so a query's round order is arbitrary. Anything walking rounds in
    // sequence has to sort them.
    expect(orderedRoundNames(["F", "QF", "TP", "SF"])).toEqual(["QF", "SF", "TP", "F"]);
    expect(orderedRoundNames(["SF", "R16", "F", "QF", "R32"])).toEqual(["R32", "R16", "QF", "SF", "F"]);
  });

  it("places the third-place match between the semis and the final", () => {
    expect(roundSequence("SF")).toBeLessThan(roundSequence("TP"));
    expect(roundSequence("TP")).toBeLessThan(roundSequence("F"));
  });

  it("never sorts an unrecognised round after the final", () => {
    expect(roundSequence("mystery")).toBeLessThan(roundSequence("F"));
  });

  it("deduplicates", () => {
    expect(orderedRoundNames(["QF", "QF", "F"])).toEqual(["QF", "F"]);
  });
});

describe("cross-group draw is rank-relative", () => {
  const q = (groupOrder: number, rank: number, teamId: string): Qualifier => ({ teamId, groupOrder, rank });

  it("draws a Plate of ranks 3 and 4 exactly as it draws a Cup of 1 and 2", () => {
    // Before this, crossGroupEntrants matched on rank === 1 and rank === 2, so a
    // Plate found neither and fell back to flat seeding — losing the cross-group
    // draw silently.
    const cup = buildBracketPlan(
      [q(0, 1, "a1"), q(0, 2, "a2"), q(1, 1, "b1"), q(1, 2, "b2")],
      false,
    );
    const plate = buildBracketPlan(
      [q(0, 3, "a3"), q(0, 4, "a4"), q(1, 3, "b3"), q(1, 4, "b4")],
      false,
    );
    const shape = (rounds: ReturnType<typeof buildBracketPlan>) =>
      rounds[0].slots.map((s) => s.sourceType);
    expect(shape(plate)).toEqual(shape(cup));
    // Each group's better-placed team meets the other group's worse-placed one.
    expect(plate[0].slots.map((s) => s.teamId)).toEqual(["a3", "b4", "b3", "a4"]);
    expect(cup[0].slots.map((s) => s.teamId)).toEqual(["a1", "b2", "b1", "a2"]);
  });

  it("still falls back to seeding when a group has an odd number of entrants", () => {
    const rounds = buildBracketPlan([q(0, 3, "a3"), q(0, 4, "a4"), q(1, 3, "b3")], false);
    expect(rounds[0].slots.some((s) => s.isBye)).toBe(true);
  });
});

describe("orderKnockoutMatches", () => {
  const round = (tier: "cup" | "plate", roundName: string, count: number) =>
    Array.from({ length: count }, (_, matchIndex) => ({ tier, roundName, matchIndex }));

  const both = [
    ...round("cup", "QF", 4),
    ...round("plate", "QF", 4),
    ...round("cup", "SF", 2),
    ...round("plate", "SF", 2),
    ...round("cup", "F", 1),
    ...round("plate", "F", 1),
  ];

  it("never schedules a later round before an earlier one, whatever the strategy", () => {
    for (const strategy of ["parallel", "sequential"] as const) {
      const out = orderKnockoutMatches(both, 4, strategy);
      const lastQf = Math.max(...out.filter((m) => m.roundName === "QF").map((m) => m.order));
      const firstSf = Math.min(...out.filter((m) => m.roundName === "SF").map((m) => m.order));
      expect(lastQf).toBeLessThan(firstSf);
    }
  });

  it("parallel interleaves the tiers and spreads them over the whole court pool", () => {
    const qf = orderKnockoutMatches(both, 4, "parallel").filter((m) => m.roundName === "QF");
    expect(qf.map((m) => m.tier)).toEqual(["cup", "plate", "cup", "plate", "cup", "plate", "cup", "plate"]);
    // Eight matches over four courts: each court takes two, and no two matches
    // sharing a court sit next to each other in the order.
    expect(qf.map((m) => m.courtIndex)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  it("sequential plays the Cup round out before the Plate starts", () => {
    const qf = orderKnockoutMatches(both, 4, "sequential").filter((m) => m.roundName === "QF");
    expect(qf.map((m) => m.tier)).toEqual(["cup", "cup", "cup", "cup", "plate", "plate", "plate", "plate"]);
    // Court indexes repeat across the tiers on purpose: separated in time.
    expect(qf.map((m) => m.courtIndex)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(qf.map((m) => m.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("orders every match exactly once, with no gaps", () => {
    const out = orderKnockoutMatches(both, 3, "parallel");
    expect(out).toHaveLength(both.length);
    expect(out.map((m) => m.order).sort((a, b) => a - b)).toEqual(both.map((_, i) => i));
  });

  it("a single-tier tournament is unaffected by the strategy", () => {
    const cupOnly = [...round("cup", "QF", 4), ...round("cup", "SF", 2), ...round("cup", "F", 1)];
    const p = orderKnockoutMatches(cupOnly, 2, "parallel");
    const q = orderKnockoutMatches(cupOnly, 2, "sequential");
    expect(p).toEqual(q);
  });

  it("puts the third-place match before the final", () => {
    const withTp = [...round("cup", "SF", 2), ...round("cup", "TP", 1), ...round("cup", "F", 1)];
    const out = orderKnockoutMatches(withTp, 2, "sequential");
    const tp = out.find((m) => m.roundName === "TP")!;
    const f = out.find((m) => m.roundName === "F")!;
    expect(tp.order).toBeLessThan(f.order);
  });

  it("leaves the court unset when a tournament has none", () => {
    const out = orderKnockoutMatches(round("cup", "F", 1), 0, "parallel");
    expect(out[0].courtIndex).toBeNull();
  });
});

describe("tier configuration", () => {
  it("the Plate is off unless enabled, so nothing changes by default", () => {
    expect(tierSizes({ type: "group_knockout" }).platePerGroup).toBe(0);
    expect(tierSizes({ type: "group_knockout", qualifyPerGroup: 2 })).toEqual({
      qualifyPerGroup: 2,
      platePerGroup: 0,
    });
  });

  it("reads the Plate size once it is on, defaulting to two per group", () => {
    const f = { type: "group_knockout" as const, tiers: { plate: { enabled: true } } };
    expect(tierSizes(f).platePerGroup).toBe(2);
    expect(tierSizes({ ...f, tiers: { plate: { enabled: true, perGroup: 1 } } }).platePerGroup).toBe(1);
  });

  it("the Cup keeps the legacy third-place flag", () => {
    expect(thirdPlaceFor({ type: "group_knockout", thirdPlaceMatch: false }, "cup")).toBe(false);
    expect(thirdPlaceFor({ type: "group_knockout", thirdPlaceMatch: true }, "cup")).toBe(true);
  });

  it("the Plate inherits the Cup's third-place setting until given its own", () => {
    const legacyOff = { type: "group_knockout" as const, thirdPlaceMatch: false };
    expect(thirdPlaceFor(legacyOff, "plate")).toBe(false);
    expect(
      thirdPlaceFor({ ...legacyOff, tiers: { plate: { enabled: true, thirdPlaceMatch: true } } }, "plate"),
    ).toBe(true);
  });

  it("caps a podium at what the bracket can actually produce", () => {
    const noTp = { type: "group_knockout" as const, thirdPlaceMatch: false, tiers: { cup: { podiumDepth: 4 as const } } };
    // No third-place match means no honest 3rd and 4th.
    expect(podiumDepthFor(noTp, "cup")).toBe(2);
    const withTp = { ...noTp, thirdPlaceMatch: true };
    expect(podiumDepthFor(withTp, "cup")).toBe(4);
  });

  it("refuses a podium depth the bracket cannot fill, naming the tier", () => {
    const problems = validatePodiumSettings({
      type: "group_knockout",
      thirdPlaceMatch: false,
      tiers: { cup: { podiumDepth: 3 } },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0].tier).toBe("cup");
    expect(problems[0].message).toContain("third-place match");
  });

  it("accepts a shallow podium without a third-place match", () => {
    expect(
      validatePodiumSettings({ type: "group_knockout", thirdPlaceMatch: false, tiers: { cup: { podiumDepth: 2 } } }),
    ).toEqual([]);
  });
});
