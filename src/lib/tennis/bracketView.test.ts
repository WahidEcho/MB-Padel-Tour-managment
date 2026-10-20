import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { placementPlan } from "./placement";
import { placementBrackets } from "./bracketView";
import type { MTie } from "../mobile/contract";

/** The ties a placement plan stores, as the app receives them (sides known only in round 1). */
function tiesOf(groups: number): MTie[] {
  const plan = placementPlan(groups, 4);
  const id = new Map(plan.map((p) => [p.key, randomUUID()]));
  const winnerTo = new Map<string, string>();
  const loserTo = new Map<string, string>();
  for (const p of plan) {
    for (const [src, side] of [[p.a, "a"], [p.b, "b"]] as const) {
      void side;
      if (src.kind === "winner") winnerTo.set(src.key, id.get(p.key)!);
      if (src.kind === "loser") loserTo.set(src.key, id.get(p.key)!);
    }
  }
  return plan.map((p, i) => ({
    id: id.get(p.key)!,
    stage: "placement",
    groupId: null,
    roundNo: p.roundNo,
    roundName: p.roundName,
    order: i + 1,
    courtId: null,
    scheduledTime: null,
    a: p.a.kind === "group" ? `T${p.a.group}${p.a.position}` : null,
    b: p.b.kind === "group" ? `T${p.b.group}${p.b.position}` : null,
    status: "scheduled",
    rubbersA: 0,
    rubbersB: 0,
    winner: null,
    placesFrom: p.placesFrom,
    placesTo: p.placesTo,
    lineupLocked: false,
    drawFrom: p.drawFrom,
    drawTo: p.drawTo,
    winnerTo: winnerTo.get(p.key) ?? null,
    loserTo: loserTo.get(p.key) ?? null,
  }));
}

describe("placementBrackets", () => {
  it("lays out four groups as the Cup (1–8) and the Plate (9–16), three rounds each", () => {
    const draws = placementBrackets(tiesOf(4));
    expect(draws.map((d) => [d.name, d.places])).toEqual([
      ["Cup", "Places 1–8"],
      ["Plate", "Places 9–16"],
    ]);
    const cup = draws[0];
    expect(cup.rounds.map((r) => r.blocks.map((b) => `${b.name}×${b.ties.length}`))).toEqual([
      ["Quarter-finals×4"],
      ["Semi-finals×2", "5th–8th play-offs×2"],
      ["Final×1", "Third place×1", "5th place play-off×1", "7th place play-off×1"],
    ]);
    expect(cup.rounds[0].blocks[0].ties.map((t) => t.ref)).toEqual(["QF 1", "QF 2", "QF 3", "QF 4"]);
  });

  it("names where an unknown side comes from", () => {
    const cup = placementBrackets(tiesOf(4))[0];
    const [sf1] = cup.rounds[1].blocks[0].ties;
    expect([sf1.a.from, sf1.b.from]).toEqual(["Winner QF 1", "Winner QF 2"]);
    const final = cup.rounds[2].blocks[0].ties[0];
    expect([final.a.from, final.b.from]).toEqual(["Winner SF 1", "Winner SF 2"]);
    const third = cup.rounds[2].blocks[1].ties[0];
    expect([third.a.from, third.b.from]).toEqual(["Loser SF 1", "Loser SF 2"]);
    expect(cup.rounds[0].blocks[0].ties[0].a).toEqual({ teamId: "T01", from: null });
  });

  it("two groups make a Cup and a Plate of four; no placement ties, no brackets", () => {
    expect(placementBrackets(tiesOf(2)).map((d) => [d.name, d.places, d.rounds.length])).toEqual([
      ["Cup", "Places 1–4", 2],
      ["Plate", "Places 5–8", 2],
    ]);
    expect(placementBrackets(tiesOf(4).map((t) => ({ ...t, stage: "group" as const })))).toEqual([]);
  });
});
