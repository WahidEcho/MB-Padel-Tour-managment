import { describe, expect, it } from "vitest";
import { eventYear, itfRanksOf, parseItfRank, playerRecord, playerSide, publicAge, withItfRanks } from "./publicInfo";
import type { MMatch } from "../mobile/contract";

describe("ITF junior rankings", () => {
  it("parses a typed rank", () => {
    expect(parseItfRank("42")).toBe(42);
    expect(parseItfRank(" #7 ")).toBe(7);
    expect(parseItfRank("")).toBeNull();
    expect(parseItfRank("0")).toBeNull();
    expect(parseItfRank("12.5")).toBeNull();
    expect(parseItfRank("abc")).toBeNull();
    expect(parseItfRank("10000")).toBeNull();
  });
  it("reads only well-formed stored ranks", () => {
    expect(itfRanksOf(null)).toEqual({});
    expect(itfRanksOf({ itfJuniorRanks: { a: 3, b: "x", c: -1, d: 2.5, e: "9" } })).toEqual({ a: 3, e: 9 });
    expect(itfRanksOf({ itfJuniorRanks: [1, 2] })).toEqual({});
  });
  it("applies updates and clears with null", () => {
    expect(withItfRanks({ a: 3, b: 4 }, { a: null, c: 5 })).toEqual({ b: 4, c: 5 });
  });
});

describe("ages (minors: only when published)", () => {
  it("is null unless the organiser publishes ages", () => {
    expect(publicAge(2010, 2026, false)).toBeNull();
    expect(publicAge(2010, 2026, true)).toBe(16);
    expect(publicAge(null, 2026, true)).toBeNull();
    expect(publicAge(2030, 2026, true)).toBeNull();
  });
  it("goes by the event's year", () => {
    expect(eventYear("2027-01-04")).toBe(2027);
    expect(eventYear(null, new Date("2026-10-20T00:00:00Z"))).toBe(2026);
  });
});

describe("playerRecord", () => {
  const base = { tieId: "t", a: "EGY", b: "USA", status: "completed", winner: "EGY", score: null } as const;
  const m = (o: Partial<MMatch>): MMatch => ({ ...base, aPlayers: [], bPlayers: [], rubberType: null, ...o }) as unknown as MMatch;
  const set = (a: number, b: number) => ({ a, b });
  const score = (sets: { a: number; b: number }[]) => ({
    sets,
    games: null,
    points: null,
    tiebreak: false,
    serving: null,
    setsWon: { a: 0, b: 0 },
    lastEventNumber: 0,
    lastUndo: 0,
    updatedAt: null,
  });
  it("counts singles and doubles apart, from the player's own side", () => {
    const ms = [
      m({ rubberType: "S1", aPlayers: ["p"], score: score([set(6, 3), set(6, 4)]) }),
      m({ rubberType: "D", aPlayers: ["p", "q"], winner: "USA", score: score([set(4, 6), set(6, 3), set(8, 10)]) }),
      m({ rubberType: "S2", a: "FRA", b: "EGY", bPlayers: ["p"], winner: "EGY" }),
      m({ rubberType: "S1", aPlayers: ["q"] }), // not their rubber
      m({ rubberType: "S1", aPlayers: ["p"], status: "live", winner: null }), // not finished
    ];
    const r = playerRecord(ms, "p", "EGY");
    expect(r.singles).toEqual({ won: 2, lost: 0 });
    expect(r.doubles).toEqual({ won: 0, lost: 1 });
    expect(r.all).toEqual({ won: 2, lost: 1 });
    expect(r.sets).toEqual({ won: 3, lost: 2 });
  });
  it("outside ties every player of a team plays its matches", () => {
    const pad = m({ tieId: null, a: "T1", b: "T2", winner: "T2" });
    expect(playerSide(pad, "p", "T1")).toBe("A");
    expect(playerRecord([pad], "p", "T1").all).toEqual({ won: 0, lost: 1 });
    expect(playerSide(m({ rubberType: "S1" }), "p", "EGY")).toBeNull();
  });
});
