import { describe, expect, it } from "vitest";
import { awardGame, awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../scoring/engine";
import { DEFAULT_SCORING_CONFIG, DEFAULT_TENNIS_SCORING_CONFIG, type MatchRules } from "../types";
import { courtBusy, courtQueue, nextOnCourt, type QueueMatch } from "./courtQueue";
import { isNearEnd, nearEndCrossed, sidesOneGameFromWinning } from "./nearEnd";
import { callDeadline, callReminderAt, callView, extendCall, reminderDue, type CourtCall } from "./call";
import { DEFAULT_MATCH_DAY_RULES, matchDayRules, type MatchDayRules } from "./rules";

/* ------------------------------------------------------------------ */
/* courtQueue                                                          */
/* ------------------------------------------------------------------ */

function qm(id: string, over: Partial<QueueMatch> = {}): QueueMatch {
  return { id, court_id: "c1", status: "scheduled", scheduled_time: null, match_order: 0, ...over };
}

describe("courtQueue", () => {
  it("orders waiting matches by time (unscheduled last), then match order", () => {
    const ms = [
      qm("late", { scheduled_time: "2026-10-13T18:00:00Z" }),
      qm("none2", { match_order: 2 }),
      qm("early", { scheduled_time: "2026-10-13T17:00:00Z", status: "ready" }),
      qm("none1", { match_order: 1 }),
      qm("live", { status: "live" }),
      qm("done", { status: "completed" }),
      qm("cancelled", { status: "cancelled" }),
      qm("other", { court_id: "c2", scheduled_time: "2026-10-13T16:00:00Z" }),
    ];
    expect(courtQueue(ms, "c1").map((m) => m.id)).toEqual(["early", "late", "none1", "none2"]);
    expect(nextOnCourt(ms, "c1")?.id).toBe("early");
    expect(nextOnCourt(ms, "c2")?.id).toBe("other");
    expect(nextOnCourt(ms, "c3")).toBeNull();
    // Without a court id the list is taken as one court's.
    expect(nextOnCourt(ms.filter((m) => m.court_id === "c1"))?.id).toBe("early");
  });

  it("knows a busy court", () => {
    expect(courtBusy([qm("a", { status: "live" })], "c1")).toBe(true);
    expect(courtBusy([qm("a", { status: "paused" })], "c1")).toBe(true);
    expect(courtBusy([qm("a", { status: "ready" }), qm("b", { status: "completed" })], "c1")).toBe(false);
    expect(courtBusy([qm("a", { status: "live", court_id: "c2" })], "c1")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* nearEnd                                                             */
/* ------------------------------------------------------------------ */

const PADEL: MatchRules = DEFAULT_SCORING_CONFIG;
const SINGLES: MatchRules = DEFAULT_TENNIS_SCORING_CONFIG;
const DOUBLES: MatchRules = { ...DEFAULT_TENNIS_SCORING_CONFIG, ...DEFAULT_TENNIS_SCORING_CONFIG.doubles };

function games(rules: MatchRules, seq: string, s: ScoreState = initialScoreState()): ScoreState {
  for (const ch of seq) s = awardGame(s, ch as TeamKey, rules);
  return s;
}

function points(rules: MatchRules, seq: string, s: ScoreState): ScoreState {
  for (const ch of seq) s = awardPoint(s, ch as TeamKey, rules);
  return s;
}

describe("nearEnd", () => {
  it("one set: 5-4 is near, 5-5 is not, 6-5 is, 6-6 (tie-break decides) is for both", () => {
    const s54 = games(PADEL, "ABABABABA"); // A 5, B 4
    expect(s54.teamA.games).toBe(5);
    expect(sidesOneGameFromWinning(PADEL, s54)).toEqual(["A"]);
    const s55 = games(PADEL, "B", s54);
    expect(isNearEnd(PADEL, s55)).toBe(false);
    const s65 = games(PADEL, "A", s55);
    expect(sidesOneGameFromWinning(PADEL, s65)).toEqual(["A"]);
    const s66 = games(PADEL, "B", s65);
    expect(s66.isTiebreak).toBe(true);
    expect(sidesOneGameFromWinning(PADEL, s66)).toEqual(["A", "B"]);
    // 5-3 (two games ahead) is near too: one more game wins.
    expect(sidesOneGameFromWinning(PADEL, games(PADEL, "AAAAABBB"))).toEqual(["A"]);
    expect(isNearEnd(PADEL, games(PADEL, "AAAABBB"))).toBe(false);
  });

  it("best of three: only in the set that can win the match", () => {
    const firstSet54 = games(SINGLES, "AAAAABBBB");
    expect(isNearEnd(SINGLES, firstSet54)).toBe(false); // winning it only wins a set
    const secondSet = games(SINGLES, "AAAAAA" + "AAAAABBBB"); // A won set 1, leads 5-4 in set 2
    expect(sidesOneGameFromWinning(SINGLES, secondSet)).toEqual(["A"]);
    const oneAll = games(SINGLES, "AAAAAA" + "BBBBBB" + "BBBBB");
    expect(sidesOneGameFromWinning(SINGLES, oneAll)).toEqual(["B"]);
  });

  it("a match tie-break counts as one game: both sides are near from its first point", () => {
    const setAll = games(DOUBLES, "AAAAAA" + "BBBBBB");
    expect(setAll.isMatchTiebreak).toBe(true);
    expect(sidesOneGameFromWinning(DOUBLES, setAll)).toEqual(["A", "B"]);
    const before = games(DOUBLES, "AAAAAA" + "BBBBB");
    // Winning set 2 only levels the match, so 0-5 in set 2 is not near; set all is.
    expect(sidesOneGameFromWinning(DOUBLES, before)).toEqual([]);
    expect(nearEndCrossed(DOUBLES, before, setAll)).toBe(true);
    // Points inside the match tie-break do not fire again.
    expect(nearEndCrossed(DOUBLES, setAll, points(DOUBLES, "AAB", setAll))).toBe(false);
  });

  it("is edge-triggered on point-by-point play", () => {
    // Walk a whole padel match point by point; count crossings.
    let s = initialScoreState();
    let crossings = 0;
    const seq = "AAAA BBBB AAAA BBBB AAAA BBBB AAAA BBBB AAAA AAAA".replace(/ /g, "");
    for (const ch of seq) {
      const next = awardPoint(s, ch as TeamKey, PADEL);
      if (nearEndCrossed(PADEL, s, next)) crossings += 1;
      s = next;
    }
    expect(s.matchOver).toBe(true);
    expect(crossings).toBe(1);
  });

  it("does not fire again while the match stays near, nor at the end", () => {
    const s54 = games(PADEL, "ABABABABA");
    const mid = points(PADEL, "AB", s54);
    expect(nearEndCrossed(PADEL, s54, mid)).toBe(false);
    const won = games(PADEL, "A", s54);
    expect(won.matchOver).toBe(true);
    expect(nearEndCrossed(PADEL, s54, won)).toBe(false);
    // 5-6 → 6-6: B was near already; A joining does not fire again.
    const s56 = games(PADEL, "BABABABABAB");
    expect(sidesOneGameFromWinning(PADEL, s56)).toEqual(["B"]);
    expect(nearEndCrossed(PADEL, s56, games(PADEL, "A", s56))).toBe(false);
  });

  it("fires when a match leaves near and comes back (callers send once per match)", () => {
    const s54 = games(PADEL, "ABABABABA");
    const s55 = games(PADEL, "B", s54);
    expect(nearEndCrossed(PADEL, s55, games(PADEL, "A", s55))).toBe(true);
  });

  it("treats a missing or non-games state as not near", () => {
    expect(nearEndCrossed(PADEL, null, null)).toBe(false);
    expect(isNearEnd(PADEL, { fen: "x" } as unknown as ScoreState)).toBe(false);
    // `before` null is the start of the match: not near.
    expect(nearEndCrossed(PADEL, null, initialScoreState())).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* call                                                                */
/* ------------------------------------------------------------------ */

const T0 = Date.parse("2026-10-13T17:00:00Z");
const MIN = 60_000;
const RULES: MatchDayRules = DEFAULT_MATCH_DAY_RULES; // 5 min, reminder −2, +5 × 2, both absent = prompt only

function call(over: Partial<CourtCall> = {}): CourtCall {
  return { calledAt: new Date(T0).toISOString(), extensions: 0, presentA: false, presentB: false, ...over };
}

describe("callView", () => {
  it("runs called → reminder → no-show prompt", () => {
    const c = call();
    expect(callDeadline(c, RULES)).toBe(T0 + 5 * MIN);
    expect(callReminderAt(c, RULES)).toBe(T0 + 3 * MIN);

    const v0 = callView(c, RULES, T0 + MIN);
    expect(v0).toMatchObject({ phase: "called", msLeft: 4 * MIN, nextChangeAt: T0 + 3 * MIN, prompt: null });
    expect(v0.actions).toEqual(["mark_present_a", "mark_present_b"]);

    const v1 = callView(c, RULES, T0 + 3 * MIN);
    expect(v1).toMatchObject({ phase: "reminder", nextChangeAt: T0 + 5 * MIN });

    const v2 = callView(c, RULES, T0 + 5 * MIN);
    expect(v2).toMatchObject({ phase: "no_show", msLeft: 0, canExtend: true, extensionsLeft: 2 });
    expect(v2.prompt).toEqual({ kind: "both_absent", absent: ["A", "B"] });
    // Both absent with "prompt only": no walkover, no double no-show.
    expect(v2.actions).toEqual(["mark_present_a", "mark_present_b", "extend"]);
  });

  it("offers the walkover to the side that is there", () => {
    const v = callView(call({ presentA: true }), RULES, T0 + 6 * MIN);
    expect(v.prompt).toEqual({ kind: "one_absent", absent: ["B"] });
    expect(v.actions).toEqual(["mark_present_b", "extend", "walkover_to_a"]);
    expect(callView(call({ presentB: true }), RULES, T0 + 6 * MIN).actions).toContain("walkover_to_b");
  });

  it("offers a double no-show when both are absent and the rules allow more than a prompt", () => {
    const rules = { ...RULES, noShow: { ...RULES.noShow, bothAbsentPromptOnly: false } };
    expect(callView(call(), rules, T0 + 5 * MIN).actions).toEqual(["mark_present_a", "mark_present_b", "extend", "both_no_show"]);
  });

  it("extends by +5 up to the maximum, each with its own reminder", () => {
    let c = call({ presentA: true });
    expect(extendCall(c, RULES, T0 + MIN)).toEqual({ ok: false, reason: "not_due" });

    const e1 = extendCall(c, RULES, T0 + 5 * MIN);
    expect(e1.ok && e1.deadlineAt).toBe(T0 + 10 * MIN);
    c = e1.ok ? e1.call : c;
    expect(callView(c, RULES, T0 + 6 * MIN).phase).toBe("called");
    expect(callView(c, RULES, T0 + 8 * MIN).phase).toBe("reminder");
    expect(reminderDue(c, RULES, T0 + 8 * MIN, T0 + 5 * MIN)).toBe(true); // reminded for the old deadline only
    expect(reminderDue(c, RULES, T0 + 8 * MIN, T0 + 10 * MIN)).toBe(false);

    const e2 = extendCall(c, RULES, T0 + 10 * MIN);
    c = e2.ok ? e2.call : c;
    expect(callDeadline(c, RULES)).toBe(T0 + 15 * MIN);
    const last = callView(c, RULES, T0 + 15 * MIN);
    expect(last).toMatchObject({ phase: "no_show", canExtend: false, extensionsLeft: 0 });
    expect(last.actions).toEqual(["mark_present_b", "walkover_to_a"]);
    expect(extendCall(c, RULES, T0 + 15 * MIN)).toEqual({ ok: false, reason: "max_extensions" });
  });

  it("is ready when both sides are there, and over once closed", () => {
    expect(callView(call({ presentA: true, presentB: true }), RULES, T0 + 9 * MIN)).toMatchObject({
      phase: "all_present",
      actions: ["start_match"],
      prompt: null,
    });
    expect(extendCall(call({ presentA: true, presentB: true }), RULES, T0 + 9 * MIN)).toEqual({ ok: false, reason: "all_present" });
    const closed = call({ closedAt: T0 + 2 * MIN });
    expect(callView(closed, RULES, T0 + 9 * MIN)).toMatchObject({ phase: "closed", actions: [] });
    expect(extendCall(closed, RULES, T0 + 9 * MIN)).toEqual({ ok: false, reason: "closed" });
  });

  it("is only overdue when no-show prompts are off", () => {
    const rules = { ...RULES, noShow: { ...RULES.noShow, on: false } };
    expect(callView(call(), rules, T0 + 7 * MIN)).toMatchObject({ phase: "overdue", prompt: null, canExtend: false });
    expect(extendCall(call(), rules, T0 + 7 * MIN)).toEqual({ ok: false, reason: "no_show_off" });
  });

  it("follows the organiser's minutes, and never reminds before the call", () => {
    const rules = matchDayRules({
      configured: true,
      courtCall: { on: true, minutes: 2, reminderMinutes: 5 },
      noShow: { on: true, extensionMinutes: 3, maxExtensions: 1 },
    });
    const c = call();
    expect(callDeadline(c, rules)).toBe(T0 + 2 * MIN);
    expect(callReminderAt(c, rules)).toBe(T0);
    expect(callView(c, rules, T0).phase).toBe("reminder");
    const e = extendCall(c, rules, T0 + 2 * MIN);
    expect(e.ok && e.deadlineAt).toBe(T0 + 5 * MIN);
    // Stored extensions above the maximum count only up to it.
    expect(callDeadline(call({ extensions: 9 }), rules)).toBe(T0 + 5 * MIN);
  });
});
