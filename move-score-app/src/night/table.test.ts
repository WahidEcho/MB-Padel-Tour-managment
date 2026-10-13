import { describe, expect, it } from "vitest";
import type { MBundle, MLive, MMatch } from "@core";
import { nightTableOf } from "./table";

const match = (over: Partial<MMatch>): MMatch => ({
  id: "m1",
  tieId: null,
  rubberNo: null,
  rubberType: null,
  stage: "friendly",
  groupId: null,
  round: "R1",
  order: 1,
  courtId: "c1",
  scheduledTime: "2026-11-03T17:00:00Z",
  status: "scheduled",
  a: "t1",
  b: "t2",
  aPlayers: [],
  bPlayers: [],
  winner: null,
  startedAt: null,
  endedAt: null,
  score: null,
  ...over,
});

const bundle = (night: boolean) =>
  ({
    tournament: { timezone: "Africa/Cairo", ...(night ? { night: { publishedAt: "2026-11-03T12:00:00Z", layout: "by_court" } } : {}) },
    teams: [
      { id: "t1", name: "Ali & Omar" },
      { id: "t2", name: "Sara & Mona" },
    ],
    courts: [
      { id: "c1", name: "Court 1", order: 1 },
      { id: "c2", name: "Court 2", order: 2 },
    ],
  }) as unknown as MBundle;

describe("the night's table on the phone", () => {
  it("is built from the live matches with the shared table, 'about' times in the event's zone", () => {
    const live = { matches: [match({}), match({ id: "m2", order: 2, courtId: "c1", scheduledTime: "2026-11-03T17:35:00Z", a: "t2", b: "t1" })] } as unknown as MLive;
    const t = nightTableOf(bundle(true), live)!;
    expect(t.courts[0].entries.map((e) => [e.position, e.label, e.a])).toEqual([
      [1, "about 19:00", "Ali & Omar"],
      [2, "about 19:35", "Sara & Mona"],
    ]);
    expect(t.courts[1].entries).toEqual([]);
  });
  it("is absent for a tournament (no night) and before there are matches", () => {
    expect(nightTableOf(bundle(false), { matches: [match({})] } as unknown as MLive)).toBeNull();
    expect(nightTableOf(bundle(true), { matches: [] } as unknown as MLive)).toBeNull();
  });
});
