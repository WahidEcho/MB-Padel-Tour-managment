import { describe, expect, it } from "vitest";
import { composeTieSchedule, composeMatchFinished, localTime } from "./compose";

describe("alert wording", () => {
  it("gives times in the event's zone and targets the tie and both nations", () => {
    const p = composeTieSchedule({
      kind: "tie_rescheduled",
      tieId: "tie1",
      tournamentId: "t",
      a: { name: "Egypt", code: "EGY" },
      b: { name: "Japan", code: "JPN" },
      court: "Court 2",
      at: "2026-11-04T13:30:00.000Z",
      timeZone: "Africa/Cairo",
      eventName: "Davis Cup Junior Finals",
    });
    expect(p.title).toBe("Moved: EGY v JPN");
    expect(p.body).toContain("15:30");
    expect(p.targets).toEqual([
      { kind: "tie", key: "tie1" },
      { kind: "nation", key: "EGY" },
      { kind: "nation", key: "JPN" },
    ]);
    expect(p.category).toBe("scheduled");
  });
  it("formats a result", () => {
    const p = composeMatchFinished({ matchId: "m", tieId: null, label: "Final", winner: "Johnson (USA)", loser: "Kawaguchi (JPN)", score: "6–4 6–4", playerIds: ["p1"] });
    expect(p.title).toBe("Johnson (USA) won");
    expect(p.targets).toContainEqual({ kind: "player", key: "p1" });
  });
  it("uses the 24-hour clock", () => {
    expect(localTime("2026-11-04T18:05:00Z", "Africa/Cairo")).toBe("20:05");
  });
});
