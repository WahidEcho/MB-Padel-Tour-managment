import { describe, expect, it } from "vitest";
import { estimateTimes, generateAmericanoSchedule } from "./scheduler";
import { buildNightTable, NIGHT_TABLE_LAYOUT, reestimateNight, type NightEstimateMatch, type NightTableMatch } from "./nightTable";

const START = "2026-11-03T17:00:00Z"; // 19:00 in Cairo (UTC+2 in November)
const T0 = Date.parse(START);
const MIN = 60_000;

/** A night of 8 players on 2 courts, as persistRounds stores it: match_order rounds first, then courts. */
function night() {
  const rounds = generateAmericanoSchedule(["a", "b", "c", "d", "e", "f", "g", "h"], { courts: 2, rounds: 3 });
  const est = estimateTimes(rounds, START, 30, 5);
  let order = 0;
  const rows: (NightEstimateMatch & { scheduled: string })[] = [];
  for (const r of rounds) {
    for (const m of [...r.matches].sort((x, y) => x.courtIndex - y.courtIndex)) {
      const e = est.find((x) => x.match === m)!;
      rows.push({ id: `m${++order}`, courtId: `c${m.courtIndex + 1}`, order, status: "scheduled", startedAt: null, endedAt: null, players: [...m.teamA, ...m.teamB], scheduled: e.startsAtIso });
    }
  }
  return rows;
}

describe("reestimateNight", () => {
  it("before the night starts it agrees with the up-front estimate", () => {
    const rows = night();
    const out = reestimateNight(rows, { start: START, matchMinutes: 30, changeoverMinutes: 5, now: T0 - 3600_000 });
    for (const r of rows) expect(out.get(r.id)).toBe(r.scheduled);
  });

  it("a match that finishes early pulls its court (and its players' next matches) forward", () => {
    const rows = night();
    rows[0] = { ...rows[0], status: "completed", startedAt: START, endedAt: new Date(T0 + 20 * MIN).toISOString() };
    rows[1] = { ...rows[1], status: "completed", startedAt: START, endedAt: new Date(T0 + 20 * MIN).toISOString() };
    const out = reestimateNight(rows, { start: START, matchMinutes: 30, changeoverMinutes: 5, now: T0 + 21 * MIN });
    // Round 2 on both courts: 20 minutes + 5 changeover, not the planned 35.
    expect(out.get("m3")).toBe(new Date(T0 + 25 * MIN).toISOString());
    expect(out.get("m4")).toBe(new Date(T0 + 25 * MIN).toISOString());
    expect(out.has("m1")).toBe(false);
  });

  it("a match that runs long pushes its court back, and never estimates before now", () => {
    const rows = night();
    rows[0] = { ...rows[0], status: "live", startedAt: START };
    rows[1] = { ...rows[1], status: "completed", startedAt: START, endedAt: new Date(T0 + 30 * MIN).toISOString() };
    const now = T0 + 50 * MIN;
    const out = reestimateNight(rows, { start: START, matchMinutes: 30, changeoverMinutes: 5, now });
    // Court 1's next match waits for the live one: not before now + changeover.
    const c1next = rows.find((r) => r.courtId === "c1" && r.status === "scheduled")!;
    expect(Date.parse(out.get(c1next.id)!)).toBeGreaterThanOrEqual(now + 5 * MIN);
    for (const iso of out.values()) expect(Date.parse(iso)).toBeGreaterThanOrEqual(now);
  });

  it("keeps each court's order: estimates rise along a court", () => {
    const rows = night();
    const out = reestimateNight(rows, { start: START, matchMinutes: 30, changeoverMinutes: 5, now: T0 });
    for (const c of ["c1", "c2"]) {
      const times = rows.filter((r) => r.courtId === c).map((r) => Date.parse(out.get(r.id)!));
      expect([...times].sort((x, y) => x - y)).toEqual(times);
    }
  });

  it("a player is never estimated on two courts at once", () => {
    const rows = night();
    rows[0] = { ...rows[0], status: "completed", startedAt: START, endedAt: new Date(T0 + 70 * MIN).toISOString() };
    const out = reestimateNight(rows, { start: START, matchMinutes: 30, changeoverMinutes: 5, now: T0 + 71 * MIN });
    const busy = new Map<string, number>();
    for (const r of rows.filter((x) => out.has(x.id)).sort((x, y) => x.order - y.order)) {
      const at = Date.parse(out.get(r.id)!);
      for (const p of r.players) {
        expect(at).toBeGreaterThanOrEqual(busy.get(p) ?? 0);
        busy.set(p, at + 30 * MIN);
      }
    }
  });

  it("no start time and nothing started: nothing to estimate", () => {
    expect(reestimateNight(night(), { start: null, matchMinutes: 30, changeoverMinutes: 5, now: T0 }).size).toBe(0);
  });

  it("a match called off before it began holds no court", () => {
    const rows = night();
    rows[0] = { ...rows[0], status: "cancelled" };
    const out = reestimateNight(rows, { start: START, matchMinutes: 30, changeoverMinutes: 5, now: T0 - MIN });
    expect(out.has("m1")).toBe(false);
    // Court 1's round 2 can start at once, unless its players are still on court 2.
    expect(Date.parse(out.get("m3")!)).toBeLessThanOrEqual(T0 + 35 * MIN);
  });
});

describe("buildNightTable", () => {
  const courts = [
    { id: "c2", name: "Court 2", order: 2 },
    { id: "c1", name: "Court 1", order: 1 },
  ];
  const at = (min: number) => new Date(T0 + min * MIN).toISOString();
  const m = (id: string, courtId: string | null, order: number, round: string, status: string, extra: Partial<NightTableMatch> = {}): NightTableMatch => ({
    id, courtId, order, round, status, scheduledTime: at(order * 10), startedAt: null, endedAt: null, a: `A${id}`, b: `B${id}`, ...extra,
  });

  it("per court, in order of play, with positions and 'about' labels in the event's zone", () => {
    const t = buildNightTable(courts, [
      m("1", "c1", 1, "R1", "completed", { startedAt: at(0), endedAt: at(25), winner: "A" }),
      m("2", "c2", 2, "R1", "live", { startedAt: at(1) }),
      m("3", "c1", 3, "R2", "ready", { scheduledTime: at(30) }),
      m("4", "c2", 4, "R2", "scheduled", { scheduledTime: at(41) }),
      m("5", "c1", 5, "R3", "scheduled", { scheduledTime: null }),
    ], { timeZone: "Africa/Cairo" });
    expect(t.layout).toBe(NIGHT_TABLE_LAYOUT);
    expect(t.courts.map((c) => c.name)).toEqual(["Court 1", "Court 2"]);
    expect(t.courts[0].entries.map((e) => [e.position, e.state, e.label])).toEqual([
      [1, "finished", "Finished"],
      [2, "called", "about 19:30"],
      [3, "waiting", "Time to come"],
    ]);
    expect(t.courts[1].entries.map((e) => [e.position, e.state, e.label])).toEqual([
      [1, "live", "On court"],
      [2, "waiting", "about 19:40"],
    ]);
    expect(t.courts[0].entries[0].winner).toBe("A");
    expect(t.courts[0].nextAt).toBe(at(30));
    expect({ matches: t.matches, finished: t.finished, live: t.live }).toEqual({ matches: 5, finished: 1, live: 1 });
  });

  it("the same entries by round, rounds in order, courts within", () => {
    const t = buildNightTable(courts, [m("1", "c2", 2, "R1", "scheduled"), m("2", "c1", 1, "R1", "scheduled"), m("3", "c1", 3, "R2", "scheduled")]);
    expect(t.rounds.map((r) => [r.round, r.entries.map((e) => e.court)])).toEqual([
      ["R1", ["Court 1", "Court 2"]],
      ["R2", ["Court 1"]],
    ]);
  });

  it("a match without a known court sits under 'Court to come'; cancelled ones do not count", () => {
    const t = buildNightTable(courts, [m("1", null, 1, "R1", "scheduled"), m("2", "c1", 2, "R1", "cancelled")]);
    expect(t.courts.map((c) => c.name)).toEqual(["Court 1", "Court 2", "Court to come"]);
    expect(t.courts[0].entries[0].label).toBe("Cancelled");
    expect(t.matches).toBe(1);
  });

  it("names only: the table carries side labels, never ids of people", () => {
    const t = buildNightTable(courts, [m("1", "c1", 1, "R1", "scheduled", { a: "Ali & Omar", b: null })]);
    const e = t.courts[0].entries[0];
    expect([e.a, e.b]).toEqual(["Ali & Omar", "TBD"]);
    expect(Object.keys(e).sort()).toEqual(["a", "at", "b", "label", "matchId", "position", "round", "state", "winner"]);
  });
});
