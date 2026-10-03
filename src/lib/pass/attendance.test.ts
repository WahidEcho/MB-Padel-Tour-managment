import { describe, expect, it } from "vitest";
import { CLOSES_AFTER_MS, OPENS_BEFORE_MS, attendancePoints, checkInWindow, isDecidingRubber, isFinal } from "./attendance";

const now = Date.parse("2026-11-04T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("check-in window", () => {
  it("is open while the match is played or called to court", () => {
    for (const status of ["live", "paused", "ready", "pending_sync"]) expect(checkInWindow({ status, scheduledAt: null, endedAt: null }, now).state).toBe("open");
  });
  it("opens shortly before the match's time, and says when", () => {
    const at = now + OPENS_BEFORE_MS + 60_000;
    const w = checkInWindow({ status: "scheduled", scheduledAt: iso(at), endedAt: null }, now);
    expect(w).toEqual({ state: "too_early", opensAt: iso(at - OPENS_BEFORE_MS) });
    expect(checkInWindow({ status: "scheduled", scheduledAt: iso(now + OPENS_BEFORE_MS), endedAt: null }, now).state).toBe("open");
    expect(checkInWindow({ status: "scheduled", scheduledAt: null, endedAt: null }, now)).toEqual({ state: "too_early", opensAt: null });
  });
  it("closes a while after the match ends", () => {
    expect(checkInWindow({ status: "completed", scheduledAt: null, endedAt: iso(now - CLOSES_AFTER_MS) }, now).state).toBe("open");
    expect(checkInWindow({ status: "completed", scheduledAt: null, endedAt: iso(now - CLOSES_AFTER_MS - 1) }, now).state).toBe("closed");
    expect(checkInWindow({ status: "completed", scheduledAt: null, endedAt: null }, now).state).toBe("closed");
  });
  it("has nothing to attend for a match never played", () => {
    expect(checkInWindow({ status: "walkover", scheduledAt: null, endedAt: iso(now) }, now).state).toBe("closed");
    expect(checkInWindow({ status: "cancelled", scheduledAt: iso(now), endedAt: null }, now).state).toBe("closed");
  });
});

describe("finals and deciding rubbers", () => {
  it("knows a final", () => {
    expect(isFinal({ placesFrom: 1, placesTo: 2 })).toBe(true);
    expect(isFinal({ placesFrom: 5, placesTo: 6, roundName: "5th place play-off" })).toBe(false);
    expect(isFinal({ roundName: "Final" })).toBe(true);
    expect(isFinal({ roundName: "Semi-final" })).toBe(false);
    expect(isFinal({ roundName: "Quarter Final" })).toBe(false);
    expect(isFinal({ roundName: "Group A" })).toBe(false);
  });
  it("knows the deciding rubber", () => {
    const tie = (s2: "A" | "B" | null, s1: "A" | "B" | null) => [
      { id: "s2", winner: s2 },
      { id: "s1", winner: s1 },
      { id: "d", winner: null },
    ];
    expect(isDecidingRubber("d", tie("A", "B"))).toBe(true);
    expect(isDecidingRubber("d", tie("A", "A"))).toBe(false);
    expect(isDecidingRubber("d", tie("A", null))).toBe(false);
    expect(isDecidingRubber("s1", tie("A", null))).toBe(false);
    expect(isDecidingRubber("x", tie("A", "B"))).toBe(false);
    expect(isDecidingRubber("only", [{ id: "only", winner: null }])).toBe(false);
  });
});

describe("attendance points", () => {
  it("gives 10 a match, more at a final and a deciding rubber", () => {
    expect(attendancePoints({ final: false, deciding: false }).points).toBe(10);
    expect(attendancePoints({ final: true, deciding: false }).points).toBe(20);
    expect(attendancePoints({ final: false, deciding: true }).points).toBe(15);
    const both = attendancePoints({ final: true, deciding: true });
    expect(both.points).toBe(25);
    expect(both.parts.map((p) => p.label)).toEqual(["Match attended", "Final", "Deciding rubber"]);
  });
});
