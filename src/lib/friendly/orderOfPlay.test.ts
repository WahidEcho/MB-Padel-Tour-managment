import { describe, expect, it } from "vitest";
import {
  aboutTime,
  estimateTimes,
  generateAmericanoSchedule,
  nextMexicanoRound,
  orderOfPlay,
  type ScheduledRound,
} from "./scheduler";

const START = "2026-10-13T16:00:00Z"; // 19:00 in Cairo (UTC+3 before the October clock change)

describe("orderOfPlay", () => {
  it("lists each court's matches round by round", () => {
    const rounds = generateAmericanoSchedule(["a", "b", "c", "d", "e", "f", "g", "h", "i"], { courts: 2, rounds: 3 });
    const order = orderOfPlay(rounds);
    expect(order.map((c) => c.courtIndex)).toEqual([0, 1]);
    for (const court of order) {
      expect(court.matches.map((m) => m.order)).toEqual([1, 2, 3]);
      expect(court.matches.map((m) => m.round)).toEqual([1, 2, 3]);
      expect(court.matches.every((m) => m.match.courtIndex === court.courtIndex)).toBe(true);
    }
  });

  it("handles rounds that use fewer courts", () => {
    const rounds: ScheduledRound[] = [
      { round: 2, matches: [{ round: 2, courtIndex: 0, teamA: ["a", "b"], teamB: ["c", "d"] }], resting: [] },
      {
        round: 1,
        matches: [
          { round: 1, courtIndex: 1, teamA: ["e", "f"], teamB: ["g", "h"] },
          { round: 1, courtIndex: 0, teamA: ["a", "b"], teamB: ["c", "d"] },
        ],
        resting: [],
      },
    ];
    const order = orderOfPlay(rounds);
    expect(order[0].matches.map((m) => m.round)).toEqual([1, 2]);
    expect(order[1].matches.map((m) => [m.round, m.order])).toEqual([[1, 1]]);
    expect(orderOfPlay([])).toEqual([]);
  });
});

describe("estimateTimes", () => {
  it("runs rounds back to back when every court plays every round", () => {
    const rounds = generateAmericanoSchedule(["a", "b", "c", "d", "e", "f", "g", "h"], { courts: 2, rounds: 3 });
    const est = estimateTimes(rounds, START, 20, 5);
    expect(est).toHaveLength(6);
    const t0 = Date.parse(START);
    expect(est.map((e) => (e.startsAt - t0) / 60_000)).toEqual([0, 0, 25, 25, 50, 50]);
    expect(est.map((e) => e.label)).toEqual(["about 19:00", "about 19:00", "about 19:25", "about 19:25", "about 19:50", "about 19:50"]);
    expect(est[0].startsAtIso).toBe("2026-10-13T16:00:00.000Z");
    expect(est[0].endsAt - est[0].startsAt).toBe(20 * 60_000);
  });

  it("waits for players who are still on another court", () => {
    // Round 2's court 1 match shares a player with round 1's court 0 match only.
    const rounds: ScheduledRound[] = [
      {
        round: 1,
        matches: [
          { round: 1, courtIndex: 0, teamA: ["a", "b"], teamB: ["c", "d"] },
          { round: 1, courtIndex: 1, teamA: ["e", "f"], teamB: ["g", "h"] },
        ],
        resting: ["i"],
      },
      { round: 2, matches: [{ round: 2, courtIndex: 1, teamA: ["a", "i"], teamB: ["e", "f"] }], resting: [] },
    ];
    const est = estimateTimes(rounds, START, 30, 10);
    expect((est[2].startsAt - Date.parse(START)) / 60_000).toBe(40);
  });

  it("starts with free players straight away on a free court", () => {
    const rounds: ScheduledRound[] = [
      { round: 1, matches: [{ round: 1, courtIndex: 0, teamA: ["a", "b"], teamB: ["c", "d"] }], resting: [] },
      { round: 2, matches: [{ round: 2, courtIndex: 1, teamA: ["e", "f"], teamB: ["g", "h"] }], resting: [] },
    ];
    const est = estimateTimes(rounds, START, 30, 10);
    expect(est.map((e) => e.startsAt)).toEqual([Date.parse(START), Date.parse(START)]);
  });

  it("works one Mexicano round at a time", () => {
    const standings = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id, i) => ({ playerProfileId: id, points: 8 - i, gameDiff: 0 }));
    const round = nextMexicanoRound(standings, 2, { courts: 2 });
    const est = estimateTimes([round], "2026-10-13T17:40:00Z", 15, 5);
    expect(est.map((e) => e.label)).toEqual(["about 20:40", "about 20:40"]);
  });

  it("rounds labels to five minutes in the event's zone, and refuses a bad start", () => {
    const t = Date.parse("2026-10-13T16:42:00Z");
    expect(aboutTime(t)).toBe("about 19:40");
    expect(aboutTime(t, "UTC")).toBe("about 16:40");
    expect(aboutTime(Date.parse("2026-10-13T16:43:00Z"), "UTC")).toBe("about 16:45");
    expect(aboutTime(t, "UTC", 1)).toBe("about 16:42");
    expect(aboutTime(t, "Not/AZone")).toBe("about 19:40");
    expect(estimateTimes([], START, 20, 5)).toEqual([]);
    expect(estimateTimes(generateAmericanoSchedule(["a", "b", "c", "d"], { courts: 1, rounds: 1 }), "nope", 20, 5)).toEqual([]);
  });
});
