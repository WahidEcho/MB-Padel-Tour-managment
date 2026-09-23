import { describe, it, expect } from "vitest";
import { lineupFor, lineupProblems, rubberPlan, tieOutcome, type RubberResult } from "./ties";
import { calculateTieStandings } from "./tieStandings";
import { firstRoundLines, placementPlan, sourceLabel } from "./placement";
import { nationByCode, normalizeNationCode } from "./nations";
import type { MatchSnapshot } from "../types";

const r = (id: string, status: RubberResult["status"], winner: "A" | "B" | null = null): RubberResult => ({ id, status, winner });

describe("tie outcome", () => {
  it("is decided at 2-0 and drops the doubles in a placement tie", () => {
    const o = tieOutcome([r("s2", "completed", "A"), r("s1", "completed", "A"), r("d", "scheduled")], false);
    expect(o).toMatchObject({ rubbersA: 2, rubbersB: 0, winner: "A", status: "completed", cancel: ["d"] });
  });
  it("plays the dead doubles in the groups", () => {
    const o = tieOutcome([r("s2", "completed", "A"), r("s1", "completed", "A"), r("d", "scheduled")], true);
    expect(o).toMatchObject({ winner: "A", status: "live", cancel: [] });
    const done = tieOutcome([r("s2", "completed", "A"), r("s1", "completed", "A"), r("d", "completed", "B")], true);
    expect(done).toMatchObject({ rubbersA: 2, rubbersB: 1, status: "completed" });
  });
  it("goes to the doubles at 1-1", () => {
    const o = tieOutcome([r("s2", "completed", "A"), r("s1", "retired", "B"), r("d", "scheduled")], false);
    expect(o).toMatchObject({ rubbersA: 1, rubbersB: 1, winner: null, status: "live", cancel: [] });
  });
  it("an undo that un-decides the tie brings the dropped doubles back", () => {
    const o = tieOutcome([r("s2", "completed", "A"), r("s1", "live"), r("d", "cancelled")], false);
    expect(o).toMatchObject({ winner: null, restore: ["d"], status: "live" });
  });
  it("a live doubles is never dropped", () => {
    const o = tieOutcome([r("s2", "completed", "B"), r("s1", "completed", "B"), r("d", "live")], false);
    expect(o.cancel).toEqual([]);
    expect(o.status).toBe("live");
  });
  it("a tie nobody has started is scheduled", () => {
    expect(tieOutcome([r("a", "scheduled"), r("b", "scheduled"), r("c", "scheduled")], true).status).toBe("scheduled");
  });
});

describe("line-ups", () => {
  const squad = ["p1", "p2", "p3"];
  it("accepts a full line-up", () => {
    expect(lineupProblems({ S1: "p1", S2: "p2", D: ["p1", "p3"] }, squad)).toEqual([]);
  });
  it("refuses one player in both singles, a short doubles and an outsider", () => {
    expect(lineupProblems({ S1: "p1", S2: "p1", D: ["p2", "x"] }, squad)).toEqual([
      "One player cannot play both singles.",
      "Choose two players for the doubles.",
    ]);
  });
  it("hands each rubber its players", () => {
    const l = { S1: "p1", S2: "p2", D: ["p1", "p3"] };
    expect(lineupFor("S2", l)).toEqual(["p2"]);
    expect(lineupFor("D", l)).toEqual(["p1", "p3"]);
  });
  it("the order of play defaults to No. 2 singles, No. 1 singles, doubles", () => {
    expect(rubberPlan(undefined)).toEqual(["S2", "S1", "D"]);
    expect(rubberPlan({ rubbers: ["S1", "S2", "D"] })).toEqual(["S1", "S2", "D"]);
    expect(rubberPlan({ rubbers: ["S1", "S1", "D"] })).toEqual(["S2", "S1", "D"]);
  });
});

describe("nations", () => {
  it("knows the ITF codes that are not ISO codes", () => {
    expect(nationByCode("ger")?.iso2).toBe("de");
    expect(nationByCode("SUI")?.iso2).toBe("ch");
    expect(nationByCode("EGY")?.name).toBe("Egypt");
    expect(nationByCode("XYZ")).toBeUndefined();
    expect(normalizeNationCode(" rou ")).toBe("ROU");
    expect(normalizeNationCode("RO")).toBeNull();
  });
});

/* ---------------- standings ---------------- */
function snap(id: string, sets: [number, number][]): MatchSnapshot {
  return {
    match_id: id,
    completed_sets: sets.map(([a, b]) => ({ teamAGames: a, teamBGames: b })),
    team_a_sets: sets.filter(([a, b]) => a > b).length,
    team_b_sets: sets.filter(([a, b]) => b > a).length,
    team_a_games: sets.at(-1)?.[0] ?? 0,
    team_b_games: sets.at(-1)?.[1] ?? 0,
  } as unknown as MatchSnapshot;
}

/**
 * Builds a finished group: `results` lists each tie as [a, b, rubbers] where
 * each rubber is the sets from a's side, e.g. [[6,4],[6,3]].
 */
function group(results: [string, string, [number, number][][]][]) {
  const teams = [...new Set(results.flatMap(([a, b]) => [a, b]))].map((id, i) => ({ id, seed_number: i + 1, team_name: id }));
  const ties: { id: string; team_a_id: string; team_b_id: string; status: "completed"; winner_team_id: string }[] = [];
  const rubbers: { id: string; tie_id: string; team_a_id: string; team_b_id: string; status: "completed"; winner_team_id: string }[] = [];
  const snaps = new Map<string, MatchSnapshot>();
  for (const [a, b, rs] of results) {
    const tieId = `${a}-${b}`;
    let wa = 0;
    rs.forEach((sets, i) => {
      const id = `${tieId}-${i}`;
      const aWon = sets.filter(([x, y]) => x > y).length > sets.filter(([x, y]) => y > x).length;
      if (aWon) wa++;
      rubbers.push({ id, tie_id: tieId, team_a_id: a, team_b_id: b, status: "completed" as const, winner_team_id: aWon ? a : b });
      snaps.set(id, snap(id, sets));
    });
    ties.push({ id: tieId, team_a_id: a, team_b_id: b, status: "completed" as const, winner_team_id: wa >= 2 ? a : b });
  }
  return calculateTieStandings("t", "g", teams, ties, rubbers, snaps);
}
const W: [number, number][] = [[6, 0], [6, 0]];
const L: [number, number][] = [[0, 6], [0, 6]];

describe("ITF group ranking", () => {
  it("ranks on ties won", () => {
    const s = group([
      ["USA", "ROU", [W, W, W]],
      ["USA", "JPN", [W, W, L]],
      ["USA", "EGY", [W, L, W]],
      ["ROU", "JPN", [W, W, W]],
      ["ROU", "EGY", [W, W, L]],
      ["JPN", "EGY", [W, W, W]],
    ]);
    expect(s.map((x) => x.team_id)).toEqual(["USA", "ROU", "JPN", "EGY"]);
    expect(s[0]).toMatchObject({ played: 3, won: 3, points: 3, rubbers_won: 7, rubbers_lost: 2 });
  });

  it("two level on ties: the tie between them decides, whatever the rubbers say", () => {
    // ROU beat USA, but USA won far more rubbers elsewhere.
    const s = group([
      ["USA", "ROU", [L, L, W]],
      ["USA", "JPN", [W, W, W]],
      ["USA", "EGY", [W, W, W]],
      ["ROU", "JPN", [W, W, L]],
      ["ROU", "EGY", [L, L, L]],
      ["JPN", "EGY", [W, W, W]],
    ]);
    // Ties: USA 2, ROU 2, JPN 1, EGY 1. USA and ROU level: ROU beat USA.
    expect(s.map((x) => x.team_id).slice(0, 2)).toEqual(["ROU", "USA"]);
    // JPN and EGY level on one tie each: JPN beat EGY.
    expect(s.map((x) => x.team_id).slice(2)).toEqual(["JPN", "EGY"]);
  });

  it("three level: rubbers won percentage first", () => {
    // A cycle: USA beat ROU, ROU beat JPN, JPN beat USA; all beat EGY 3-0.
    const s = group([
      ["USA", "ROU", [W, W, W]], // USA 3-0
      ["ROU", "JPN", [W, W, L]], // ROU 2-1
      ["JPN", "USA", [W, W, L]], // JPN 2-1
      ["USA", "EGY", [W, W, W]],
      ["ROU", "EGY", [W, W, W]],
      ["JPN", "EGY", [W, W, W]],
    ]);
    // Rubbers: USA 3+1+3=7/9, ROU 0+2+3=5/9, JPN 1+2+3=6/9.
    expect(s.map((x) => x.team_id)).toEqual(["USA", "JPN", "ROU", "EGY"]);
  });

  it("three level, two still level after rubbers: those two go to head to head", () => {
    // USA, ROU and JPN all win two ties. Rubbers: USA 7/9, ROU 5/9, JPN 5/9, so
    // USA is first and ROU v JPN is settled by their tie (ROU won it), even
    // though JPN has the better sets.
    const s = group([
      ["USA", "ROU", [W, W, W]],
      ["ROU", "JPN", [W, W, L]],
      ["JPN", "USA", [W, W, L]],
      ["USA", "EGY", [W, W, W]],
      ["ROU", "EGY", [W, W, W]],
      ["JPN", "EGY", [W, W, L]],
    ]);
    expect(s.map((x) => x.team_id)).toEqual(["USA", "ROU", "JPN", "EGY"]);
    expect(s.find((x) => x.team_id === "JPN")!.rubbers_won).toBe(5);
  });
});

/* ---------------- placement ---------------- */
describe("placement draws", () => {
  const plan = placementPlan(4, 4);
  it("16 nations in four groups: 24 ties, every place from 1 to 16 decided once", () => {
    expect(plan).toHaveLength(24);
    const finals = plan.filter((t) => t.placesFrom !== null);
    expect(finals).toHaveLength(8);
    const places = finals.flatMap((t) => [t.placesFrom, t.placesTo]).sort((a, b) => a! - b!);
    expect(places).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
  it("round one pairs across groups: A1 v C2 at the top, D1 on the bottom line", () => {
    const qf = plan.filter((t) => t.drawFrom === 1 && t.roundNo === 1);
    expect(qf.map((t) => `${sourceLabel(t.a)}-${sourceLabel(t.b)}`)).toEqual(["A1-C2", "D2-B1", "C1-A2", "B2-D1"]);
    const low = plan.filter((t) => t.drawFrom === 9 && t.roundNo === 1);
    expect(low.map((t) => `${sourceLabel(t.a)}-${sourceLabel(t.b)}`)).toEqual(["A3-C4", "D4-B3", "C3-A4", "B4-D3"]);
  });
  it("no group plays itself in round one, and a group's two nations start in opposite halves", () => {
    for (const lines of [firstRoundLines(4, 1, 2), firstRoundLines(4, 3, 4)]) {
      for (let i = 0; i < 8; i += 2) {
        const [a, b] = [lines[i], lines[i + 1]] as { group: number }[];
        expect(a.group).not.toBe(b.group);
      }
      const half = (g: number) => lines.findIndex((l) => (l as { group: number }).group === g) < 4;
      for (let g = 0; g < 4; g++) {
        const idx = lines.map((l, i) => ((l as { group: number }).group === g ? i : -1)).filter((i) => i >= 0);
        expect(idx[0] < 4).not.toBe(idx[1] < 4);
        void half;
      }
    }
  });
  it("winners play up and losers play down, into the right places", () => {
    const byKey = new Map(plan.map((t) => [t.key, t]));
    const qf1 = plan.find((t) => t.drawFrom === 1 && t.roundNo === 1 && t.slot === 0)!;
    const sf = byKey.get(qf1.winnerTo!.key)!;
    const po = byKey.get(qf1.loserTo!.key)!;
    expect(sf.roundName).toBe("Semi-finals");
    expect(po.roundName).toBe("5th–8th play-offs");
    expect(byKey.get(sf.winnerTo!.key)!.roundName).toBe("Final");
    expect(byKey.get(sf.loserTo!.key)!.roundName).toBe("Third place");
    expect(byKey.get(po.winnerTo!.key)!.roundName).toBe("5th place play-off");
    expect(byKey.get(po.loserTo!.key)!.roundName).toBe("7th place play-off");
    // Final ties send nobody anywhere.
    expect(plan.filter((t) => t.placesFrom !== null).every((t) => !t.winnerTo && !t.loserTo)).toBe(true);
  });
  it("two groups make one draw of four per pair of positions", () => {
    const small = placementPlan(2, 4);
    expect(small).toHaveLength(8);
    expect(small.filter((t) => t.roundNo === 1 && t.drawFrom === 1).map((t) => `${sourceLabel(t.a)}-${sourceLabel(t.b)}`)).toEqual(["A1-B2", "B1-A2"]);
  });
});
