import { describe, expect, it } from "vitest";
import { callCardModel, callClock, noShowOptions, type CallSnapshot } from "./callCard";
import { callView } from "./call";
import { DEFAULT_MATCH_DAY_RULES, OFF_MATCH_DAY_RULES, type MatchDayRules } from "./rules";

const MIN = 60_000;
const T0 = Date.parse("2026-10-13T10:00:00Z");
const names = { A: "Egypt", B: "Spain" };
const rules: MatchDayRules = DEFAULT_MATCH_DAY_RULES; // 5 min, reminder −2, +5 up to 2, both absent prompt only
const call = (over: Partial<CallSnapshot> = {}): CallSnapshot => ({
  status: "called",
  calledAt: new Date(T0).toISOString(),
  extensions: 0,
  presentA: false,
  presentB: false,
  ...over,
});
const model = (c: CallSnapshot | null, at: number, extra: Partial<Parameters<typeof callCardModel>[0]> = {}) =>
  callCardModel({ call: c, rules, nowMs: at, matchStatus: c?.status === "called" ? "ready" : "scheduled", hasCourt: true, names, ...extra });

describe("callClock", () => {
  it("rounds up to the second and never goes below zero", () => {
    expect(callClock(5 * MIN)).toBe("5:00");
    expect(callClock(61_001)).toBe("1:02");
    expect(callClock(-10)).toBe("0:00");
  });
});

describe("callCardModel", () => {
  it("hides when court calls are off or the match has started", () => {
    expect(callCardModel({ call: null, rules: OFF_MATCH_DAY_RULES, nowMs: T0, matchStatus: "scheduled", hasCourt: true, names }).show).toBe(false);
    expect(model(call(), T0, { matchStatus: "live" }).show).toBe(false);
  });

  it("offers the call when not called, only with a court", () => {
    const m = model(null, T0);
    expect(m).toMatchObject({ show: true, canCall: true, phase: "not_called", countdown: null });
    expect(model(null, T0, { hasCourt: false }).canCall).toBe(false);
    expect(model(call({ status: "cancelled" }), T0).canCall).toBe(true);
  });

  it("counts down to the deadline and turns urgent at the reminder", () => {
    const m = model(call(), T0 + 30_000);
    expect(m).toMatchObject({ phase: "called", countdown: "4:30", urgent: false, tickMs: 1000 });
    expect(m.sides.map((s) => s.canMark)).toEqual([true, true]);
    const r = model(call({ presentA: true }), T0 + 3.5 * MIN);
    expect(r).toMatchObject({ phase: "reminder", urgent: true, detail: "Waiting for Spain." });
    expect(r.sides[0]).toMatchObject({ present: true, canMark: false });
  });

  it("all present: ready to start, nothing ticking", () => {
    expect(model(call({ presentA: true, presentB: true }), T0 + MIN)).toMatchObject({ phase: "all_present", tickMs: null, noShow: null });
  });

  it("one side absent after the deadline: extend and the walkover to the side that is here", () => {
    const m = model(call({ presentB: true }), T0 + 5 * MIN);
    expect(m.phase).toBe("no_show");
    expect(m.title).toBe("Egypt is not here");
    expect(m.noShow?.map((o) => o.choice)).toEqual(["wait", "extend", "walkover_to_b"]);
    expect(m.noShow?.find((o) => o.choice === "walkover_to_b")).toMatchObject({ danger: true, label: "Walkover to Spain" });
  });

  it("no extension once the maximum is used", () => {
    const m = model(call({ presentA: true, extensions: 2 }), T0 + 15 * MIN);
    expect(m.noShow?.map((o) => o.choice)).toEqual(["wait", "walkover_to_a"]);
  });

  it("both absent never offers a walkover; both no-shows only when the rules allow more than a prompt", () => {
    const m = model(call(), T0 + 5 * MIN);
    expect(m.noShow?.map((o) => o.choice)).toEqual(["wait", "extend"]);
    const strict: MatchDayRules = { ...rules, noShow: { ...rules.noShow, bothAbsentPromptOnly: false } };
    const v = callView({ calledAt: T0, extensions: 0, presentA: false, presentB: false }, strict, T0 + 5 * MIN);
    expect(noShowOptions(v, strict, names).map((o) => o.choice)).toEqual(["wait", "extend", "both_no_show"]);
  });

  it("no-show prompt off: overdue, no sheet", () => {
    const quiet: MatchDayRules = { ...rules, noShow: { ...rules.noShow, on: false } };
    const m = callCardModel({ call: call(), rules: quiet, nowMs: T0 + 6 * MIN, matchStatus: "ready", hasCourt: true, names });
    expect(m).toMatchObject({ phase: "overdue", noShow: null, countdown: "0:00" });
  });
});
