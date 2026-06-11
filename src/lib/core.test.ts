import { describe, it, expect } from "vitest";
import { roundRobin, matchesPerGroup } from "./roundrobin";
import { groupSizes, generateDraw, generateDrawOptions } from "./draws";
import { buildBracketPlan, advanceTarget, roundNameForSize } from "./bracket";
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
