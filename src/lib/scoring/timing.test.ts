/**
 * Scoring v2 timers and the change-of-ends schedule (ITF Rule 10, Rule 29a).
 */
import { describe, expect, it } from "vitest";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "./engine";
import { afterScoreChange, clockText, endChangesSoFar, liveClock, sidesSwapped, startClock, stopClock, timerView, TIMERS } from "./timing";
import { applyLet } from "./serve";
import { scoringConfigForMatch } from "./rules";
import { DEFAULT_TENNIS_SCORING_CONFIG, type ScoringConfig } from "../types";

const tennis = { sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG };
const singles = scoringConfigForMatch(tennis, { stage: "group" });
const doubles = scoringConfigForMatch(tennis, { stage: "group" }, null, { doubles: true });

function step(s: ScoreState, team: TeamKey, cfg: ScoringConfig = singles) {
  const next = awardPoint(s, team, cfg);
  return { next, after: afterScoreChange(s, next) };
}

/** Plays a game for `team`; returns the state and what followed its last point. */
function game(s: ScoreState, team: TeamKey, cfg: ScoringConfig = singles) {
  let r = { next: s, after: afterScoreChange(s, s) };
  for (let i = 0; i < 4; i++) r = step(r.next, team, cfg);
  return r;
}

describe("between points and changeovers (Rule 29a)", () => {
  it("25 s after an ordinary point", () => {
    const r = step(initialScoreState("A"), "A");
    expect(r.after).toEqual({ changeEnds: false, timer: "between_points" });
  });

  it("change ends after game 1 with no rest (25 s), then 90 s after games 3, 5…, nothing after even games", () => {
    let s = initialScoreState("A");
    const seen: string[] = [];
    for (let g = 1; g <= 5; g++) {
      const r = game(s, g % 2 === 1 ? "A" : "B");
      seen.push(`${g}:${r.after.changeEnds ? "change" : "stay"}:${r.after.timer}`);
      s = r.next;
    }
    expect(seen).toEqual([
      "1:change:between_points",
      "2:stay:between_points",
      "3:change:changeover",
      "4:stay:between_points",
      "5:change:changeover",
    ]);
  });

  it("set break of 2:00 at the end of a set; ends change only when the set's games are odd", () => {
    let s = initialScoreState("A");
    let r = { next: s, after: afterScoreChange(s, s) };
    for (let g = 0; g < 6; g++) r = game(r.next, "A"); // 6-0: six games, even
    expect(r.after).toEqual({ changeEnds: false, timer: "set_break" });
    s = initialScoreState("A");
    for (let g = 0; g < 5; g++) s = game(s, "A").next;
    for (let g = 0; g < 2; g++) s = game(s, "B").next; // 5-2
    r = game(s, "A"); // 6-2: eight games
    expect(r.after.timer).toBe("set_break");
    expect(r.after.changeEnds).toBe(false);
  });

  it("a 6-3 set (nine games) ends with a change of ends and the set break", () => {
    let s = initialScoreState("A");
    for (let g = 0; g < 3; g++) s = game(game(s, "A").next, "B").next; // 3-3
    s = game(s, "A").next;
    s = game(s, "A").next; // 5-3
    const r = game(s, "A");
    expect(r.after).toEqual({ changeEnds: true, timer: "set_break" });
  });

  it("in a tie-break: change ends every six points with no rest; a 7-6 set (13 games) changes at its end", () => {
    let s = initialScoreState("A");
    for (let g = 0; g < 6; g++) s = game(game(s, "A").next, "B").next;
    expect(s.isTiebreak).toBe(true);
    const changes: number[] = [];
    for (let p = 1; p <= 11; p++) {
      const r = step(s, p % 2 ? "A" : "B");
      if (r.after.changeEnds) changes.push(p);
      expect(r.after.timer).toBe("between_points");
      s = r.next;
    }
    expect(changes).toEqual([6]);
    // 6-5 → 7-5: the set; 13 games, odd.
    const r = step(s, "A");
    expect(r.after).toEqual({ changeEnds: true, timer: "set_break" });
  });

  it("a match tie-break changes ends every six points", () => {
    let s = initialScoreState("A");
    for (let g = 0; g < 6; g++) s = game(s, "A", doubles).next;
    for (let g = 0; g < 6; g++) s = game(s, "B", doubles).next;
    expect(s.isMatchTiebreak).toBe(true);
    const changes: number[] = [];
    for (let p = 1; p <= 13; p++) {
      const r = step(s, p % 2 ? "A" : "B", doubles);
      if (r.after.changeEnds) changes.push(p);
      s = r.next;
    }
    expect(changes).toEqual([6, 12]);
  });

  it("nothing when the score did not move (a let), or when the match is over", () => {
    const s = initialScoreState("A");
    expect(afterScoreChange(s, applyLet(s, "point"))).toEqual({ changeEnds: false, timer: null });
    const over = { ...s, matchOver: true };
    expect(afterScoreChange(s, over).timer).toBeNull();
  });
});

describe("ends so far, and the referee's left and right", () => {
  it("counts every change of ends, so Undo puts the sides back by itself", () => {
    let s = initialScoreState("A");
    expect(endChangesSoFar(s)).toBe(0);
    s = game(s, "A").next; // 1-0: change
    expect(endChangesSoFar(s)).toBe(1);
    s = game(s, "B").next; // 1-1
    expect(endChangesSoFar(s)).toBe(1);
    s = game(s, "A").next; // 2-1: change
    expect(endChangesSoFar(s)).toBe(2);
    expect(sidesSwapped(s, { auto: true, manual: false })).toBe(false);
    s = game(s, "A").next;
    s = game(s, "A").next; // 4-1: change after game 5
    expect(endChangesSoFar(s)).toBe(3);
    expect(sidesSwapped(s, { auto: true, manual: false })).toBe(true);
    expect(sidesSwapped(s, { auto: true, manual: true })).toBe(false);
    expect(sidesSwapped(s, { auto: false, manual: true })).toBe(true);
    expect(sidesSwapped(s, { auto: false, manual: false })).toBe(false);
  });

  it("agrees with afterScoreChange point by point through two sets and a tie-break", () => {
    let s = initialScoreState("A");
    let changes = 0;
    const seq: TeamKey[] = [];
    // Set 1: 6-6 then a 7-4 tie-break; set 2: 6-3.
    for (let g = 0; g < 6; g++) seq.push(..."AAAA".split("") as TeamKey[], ..."BBBB".split("") as TeamKey[]);
    seq.push(..."ABABABAAAAA".split("") as TeamKey[]);
    for (let g = 0; g < 3; g++) seq.push(..."AAAA".split("") as TeamKey[], ..."BBBB".split("") as TeamKey[]);
    seq.push(..."AAAAAAAAAAAA".split("") as TeamKey[]);
    for (const t of seq) {
      if (s.matchOver) break;
      const r = step(s, t);
      if (r.after.changeEnds) changes++;
      s = r.next;
      if (!s.matchOver) expect(endChangesSoFar(s)).toBe(changes);
    }
  });
});

describe("timer views", () => {
  it("25 s counts up and turns red with a ruling after 0:25", () => {
    expect(timerView("between_points", 18_400)).toMatchObject({ text: "0:18", over: false, ruling: false });
    expect(timerView("between_points", 27_000)).toMatchObject({ text: "0:27", over: true, overBy: 2, ruling: true, progress: 1 });
  });

  it("changeover 1:30, set break 2:00, each with a ruling once over", () => {
    expect(TIMERS.changeover.limit).toBe(90);
    expect(TIMERS.set_break.limit).toBe(120);
    expect(timerView("changeover", 98_000)).toMatchObject({ text: "1:38", over: true, overBy: 8, ruling: true });
    expect(timerView("set_break", 119_000).over).toBe(false);
    expect(timerView("set_break", 121_000).ruling).toBe(true);
  });

  it("a break is an open stopwatch; bathroom warns after 10:00 with no ruling; hydration counts to 10:00", () => {
    expect(timerView("break", 3_600_000)).toMatchObject({ over: false, progress: null, text: "60:00" });
    expect(timerView("bathroom", 599_000).over).toBe(false);
    expect(timerView("bathroom", 614_000)).toMatchObject({ over: true, ruling: false, text: "10:14" });
    expect(timerView("hydration", 601_000)).toMatchObject({ over: true, ruling: false });
  });

  it("clock text", () => {
    expect(clockText(0)).toBe("0:00");
    expect(clockText(90)).toBe("1:30");
    expect(clockText(-3)).toBe("0:00");
  });
});

describe("the timer screens show", () => {
  const t0 = Date.parse("2026-10-20T10:00:00Z");
  it("runs while its score stands, stops on TIMER_STOPPED or when a point is played", () => {
    const s = startClock(initialScoreState("A"), "changeover", new Date(t0).toISOString());
    expect(liveClock(s, t0 + 45_000)).toMatchObject({ kind: "changeover", text: "0:45" });
    expect(liveClock(stopClock(s), t0 + 45_000)).toBeNull();
    expect(liveClock(awardPoint(s, "A", singles), t0 + 45_000)).toBeNull();
  });

  it("never the 25 s, never a forgotten one", () => {
    const s = startClock(initialScoreState("A"), "between_points", new Date(t0).toISOString());
    expect(liveClock(s, t0 + 5_000)).toBeNull();
    const b = startClock(initialScoreState("A"), "break", new Date(t0).toISOString(), "B");
    expect(liveClock(b, t0 + 5_000)?.team).toBe("B");
    expect(liveClock(b, t0 + 31 * 60_000)).toBeNull();
  });
});
