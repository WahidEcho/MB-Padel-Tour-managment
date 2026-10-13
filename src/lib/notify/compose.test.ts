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

describe("match-day wording", () => {
  const base = { matchId: "m2", a: "Team A", b: "Team B", court: "Court 2", label: "Group A" };
  it("match soon: the players' own wording; fans only when starred fans is on", async () => {
    const { composeMatchSoon, CATEGORY } = await import("./compose");
    const off = composeMatchSoon({ ...base, playerIds: ["p1"], starredFans: false });
    expect(off.category).toBe("court");
    expect(CATEGORY.match_soon).toBe("court");
    expect(off.targets).toEqual([]);
    expect(off.self).toEqual({ playerIds: ["p1"], title: "You're next on Court 2", body: expect.stringContaining("one game from the end") });
    expect(composeMatchSoon({ ...base, playerIds: ["p1"], starredFans: true }).targets).toEqual([{ kind: "match", key: "m2" }]);
  });
  it("called to court and the reminder give the deadline in the event's zone", async () => {
    const { composeCalledToCourt, composeCallReminder } = await import("./compose");
    const called = composeCalledToCourt({ ...base, playerIds: ["p1", "p2"], deadline: "2026-11-04T12:35:00Z", timeZone: "Africa/Cairo", minutes: 5 });
    expect(called.self?.title).toBe("You're called to Court 2");
    expect(called.self?.body).toContain("14:35");
    expect(called.category).toBe("court");
    const reminder = composeCallReminder({ ...base, playerIds: ["p2"], deadline: "2026-11-04T12:35:00Z", timeZone: "Africa/Cairo", minutesLeft: 2 });
    expect(reminder.self?.playerIds).toEqual(["p2"]);
    expect(reminder.self?.title).toBe("2 min left to reach Court 2");
    expect(JSON.stringify([called, reminder])).not.toMatch(/phone|email|access_code/);
  });
});
