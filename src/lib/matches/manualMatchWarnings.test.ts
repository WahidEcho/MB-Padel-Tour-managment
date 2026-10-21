import { describe, it, expect } from "vitest";
import { manualMatchWarnings, type ExistingMatch } from "./manualMatchWarnings";

const NOW = Date.parse("2026-11-02T10:00:00Z"); // 12:00 in Cairo
const ctx = (tieFormat: boolean) => ({
  tieFormat,
  teamName: (id: string) => ({ egy: "Egypt", usa: "United States", jpn: "Japan" })[id] ?? id,
  courtName: (id: string) => ({ c5: "Court 5", c6: "Court 6" })[id] ?? id,
  timeZone: "Africa/Cairo",
  nowMs: NOW,
});
const m = (a: string, b: string, status: string, extra: Partial<ExistingMatch> = {}): ExistingMatch => ({
  team_a_id: a,
  team_b_id: b,
  court_id: null,
  status,
  scheduled_time: "2026-11-02T08:00:00Z",
  ...extra,
});
const codes = (w: { code: string }[]) => w.map((x) => x.code);

describe("warnings before a match is added by hand", () => {
  it("a clean match in a group has nothing to warn about", () => {
    expect(manualMatchWarnings({ teamA: "egy", teamB: "usa", courtId: "c5", groupId: "g1" }, [], ctx(false))).toEqual([]);
  });

  it("names a pair that already meets, counting a tie's rubbers once", () => {
    const tie = [m("egy", "usa", "completed", { tie_id: "t1" }), m("egy", "usa", "completed", { tie_id: "t1" }), m("egy", "usa", "scheduled", { tie_id: "t1" })];
    const w = manualMatchWarnings({ teamA: "usa", teamB: "egy", courtId: null, groupId: null }, tie, ctx(true));
    expect(w[0]).toEqual({ code: "same_pair", message: "United States and Egypt already have 1 tie against each other, not finished yet." });
  });

  it("warns when a nation is playing now, or has an unfinished match today", () => {
    const list = [m("egy", "jpn", "live", { court_id: "c6" }), m("usa", "jpn", "scheduled", { scheduled_time: null })];
    const w = manualMatchWarnings({ teamA: "egy", teamB: "usa", courtId: null, groupId: "g" }, list, ctx(false));
    expect(w.map((x) => x.message)).toEqual(["Egypt is playing now on Court 6.", "United States already has 1 match today not finished."]);
  });

  it("ignores another day's and finished matches", () => {
    const list = [m("egy", "jpn", "scheduled", { scheduled_time: "2026-11-03T08:00:00Z", court_id: "c5" }), m("usa", "jpn", "completed", { court_id: "c5" })];
    expect(manualMatchWarnings({ teamA: "egy", teamB: "usa", courtId: "c5", groupId: "g" }, list, ctx(false))).toEqual([]);
  });

  it("warns when the court still has matches to finish today", () => {
    const list = [m("jpn", "x", "live", { court_id: "c5" }), m("y", "z", "scheduled", { court_id: "c5" })];
    const w = manualMatchWarnings({ teamA: "egy", teamB: "usa", courtId: "c5", groupId: "g" }, list, ctx(false));
    expect(w).toEqual([{ code: "court_busy", message: "Court 5 already has 2 matches not finished today (in play now: Japan v x)." }]);
  });

  it("a nations event: a hand-made match is outside the draw", () => {
    const w = manualMatchWarnings({ teamA: "egy", teamB: "usa", courtId: null, groupId: "g" }, [], ctx(true));
    expect(codes(w)).toEqual(["outside_draw"]);
    expect(w[0].message).toContain("not count in the group ranking");
  });

  it("any other event: outside the draw only without a group", () => {
    expect(codes(manualMatchWarnings({ teamA: "egy", teamB: "usa", courtId: null, groupId: null }, [], ctx(false)))).toEqual(["outside_draw"]);
  });
});
