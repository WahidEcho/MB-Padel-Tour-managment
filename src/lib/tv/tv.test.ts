import { describe, it, expect } from "vitest";
import { ENTRANCE, RESULT, anchoredNow, elapsedSince, seekStyle, stageForElapsed } from "./timeline";
import { classifyPointChange, type ScoreFrame } from "./pointBeat";
import { courtSlots } from "./courtSlots";
import type { Match } from "../types";

/* ------------------------------------------------------------------ */
/* timeline                                                            */
/* ------------------------------------------------------------------ */

describe("anchoredNow", () => {
  it("corrects a client clock that is minutes out", () => {
    // The server said 10:00:00 when the client thought it was 09:57:00.
    const anchor = { serverMs: 36_000_000, clientMs: 35_820_000 };
    // Five seconds later on the client:
    expect(anchoredNow(anchor, 35_825_000)).toBe(36_005_000);
  });

  it("falls back to the client clock before the first poll", () => {
    expect(anchoredNow(null, 123)).toBe(123);
  });
});

describe("elapsedSince", () => {
  it("never goes negative, so a clock slightly ahead cannot schedule the past", () => {
    const start = new Date(10_000).toISOString();
    expect(elapsedSince(start, 9_000)).toBe(0);
    expect(elapsedSince(start, 12_500)).toBe(2_500);
  });

  it("is null when there is no start", () => {
    expect(elapsedSince(null, 1)).toBeNull();
    expect(elapsedSince("not a date", 1)).toBeNull();
  });
});

describe("stageForElapsed", () => {
  const marks = [0, 500, 1300];

  it("is -1 before the first mark and walks forward through the stages", () => {
    expect(stageForElapsed([100, 200], 50)).toBe(-1);
    expect(stageForElapsed(marks, 0)).toBe(0);
    expect(stageForElapsed(marks, 499)).toBe(0);
    expect(stageForElapsed(marks, 500)).toBe(1);
    expect(stageForElapsed(marks, 5_000)).toBe(2);
  });

  it("is the same answer however many times it is asked — so a refresh cannot replay", () => {
    const once = stageForElapsed(ENTRANCE.marks, 4_200);
    for (let i = 0; i < 5; i++) expect(stageForElapsed(ENTRANCE.marks, 4_200)).toBe(once);
  });

  it("reports finished once past the skip window, so a late joiner sees the settled frame", () => {
    expect(stageForElapsed(ENTRANCE.marks, ENTRANCE.skipAfterMs, { skipAfterMs: ENTRANCE.skipAfterMs })).toBe(
      ENTRANCE.marks.length,
    );
    expect(stageForElapsed(ENTRANCE.marks, 8_300, { skipAfterMs: ENTRANCE.skipAfterMs })).toBe(5);
  });

  it("treats no start at all as finished", () => {
    expect(stageForElapsed(marks, null)).toBe(marks.length);
  });
});

describe("the named timelines", () => {
  it("the entrance is 9 seconds with its time in the hold", () => {
    expect(ENTRANCE.durationMs).toBe(9_000);
    const hold = ENTRANCE.marks[5] - ENTRANCE.marks[4];
    const motion = ENTRANCE.marks[4];
    expect(hold).toBeGreaterThan(motion);
  });

  it("marks run forward", () => {
    for (const t of [ENTRANCE, RESULT]) {
      expect([...t.marks].sort((a, b) => a - b)).toEqual(t.marks);
    }
  });

  it("the result animation is 5 seconds and the hold outlasts it", () => {
    expect(RESULT.durationMs).toBe(5_000);
    expect(RESULT.holdMs).toBeGreaterThan(RESULT.durationMs);
  });
});

describe("seekStyle", () => {
  it("starts a keyframe animation part-way through with a negative delay", () => {
    expect(seekStyle(1_200)).toEqual({ animationDelay: "-1200ms" });
    // A beat that begins at 500ms, looked at 200ms in, has not started yet.
    expect(seekStyle(200, 500)).toEqual({ animationDelay: "300ms" });
  });
});

/* ------------------------------------------------------------------ */
/* classifyPointChange                                                 */
/* ------------------------------------------------------------------ */

function frame(over: Partial<ScoreFrame> = {}): ScoreFrame {
  return {
    eventNumber: 10,
    undoWatermark: 0,
    sets: [0, 0],
    games: [2, 1],
    tiebreak: false,
    tiebreakPoints: [0, 0],
    points: ["15", "0"],
    matchOver: false,
    ...over,
  };
}
const ctx = { observedGapMs: 2_000 };

describe("classifyPointChange", () => {
  it("says nothing on the first look — it has nothing to compare with", () => {
    expect(classifyPointChange(null, frame(), ctx)).toEqual({ kind: "none", reason: "first-look" });
  });

  it("says nothing when nothing happened", () => {
    expect(classifyPointChange(frame(), frame(), ctx).kind).toBe("none");
  });

  it("reads a plain point for the right side", () => {
    const beat = classifyPointChange(frame(), frame({ eventNumber: 11, points: ["30", "0"] }), ctx);
    expect(beat).toEqual({ kind: "point", side: "A" });
    const other = classifyPointChange(frame(), frame({ eventNumber: 11, points: ["15", "15"] }), ctx);
    expect(other).toEqual({ kind: "point", side: "B" });
  });

  it("reads losing an advantage as a point for the other side", () => {
    // At AD-40 the trailing side wins the point; it is the leader who drops to 40.
    const prev = frame({ points: ["AD", "40"] });
    const next = frame({ eventNumber: 11, points: ["40", "40"] });
    expect(classifyPointChange(prev, next, ctx)).toEqual({ kind: "point", side: "B" });
  });

  it("reads a won game as a game, not as a lost point", () => {
    // 40-0 back to 0-0 looks like a point lost unless games are checked first.
    const prev = frame({ games: [2, 1], points: ["40", "0"] });
    const next = frame({ eventNumber: 11, games: [3, 1], points: ["0", "0"] });
    expect(classifyPointChange(prev, next, ctx)).toEqual({ kind: "game", side: "A" });
  });

  it("reads a won set as a set, even though games reset to zero", () => {
    // Games going 5-4 to 0-0 must not be mistaken for an undo.
    const prev = frame({ sets: [0, 0], games: [5, 4], points: ["40", "15"] });
    const next = frame({ eventNumber: 11, sets: [1, 0], games: [0, 0], points: ["0", "0"] });
    expect(classifyPointChange(prev, next, ctx)).toEqual({ kind: "set", side: "A" });
  });

  it("counts tie-break points numerically", () => {
    const prev = frame({ games: [6, 6], tiebreak: true, tiebreakPoints: [3, 2], points: ["0", "0"] });
    const next = frame({ eventNumber: 11, games: [6, 6], tiebreak: true, tiebreakPoints: [3, 3], points: ["0", "0"] });
    expect(classifyPointChange(prev, next, ctx)).toEqual({ kind: "point", side: "B" });
  });

  it("snaps silently on an undo, even though the event number went up", () => {
    // Events are append-only: the UNDO is a higher number than the point it
    // cancels, so the number alone never reveals that anything was taken back.
    const prev = frame({ eventNumber: 11, points: ["30", "0"] });
    const next = frame({ eventNumber: 12, undoWatermark: 12, points: ["15", "0"] });
    expect(classifyPointChange(prev, next, ctx)).toEqual({ kind: "none", reason: "undo" });
  });

  it("snaps silently when undo-then-rescore lands in one poll", () => {
    // The referee's commonest correction: undo the wrong side, tap the right
    // one. Both events arrive together and the score looks like a fresh point
    // — for the wrong side unless the undo watermark is checked.
    const prev = frame({ eventNumber: 11, points: ["30", "0"] });
    const next = frame({ eventNumber: 13, undoWatermark: 12, points: ["15", "15"] });
    expect(classifyPointChange(prev, next, ctx).kind).toBe("none");
  });

  it("snaps silently when a game is taken back", () => {
    const prev = frame({ games: [3, 1] });
    const next = frame({ eventNumber: 11, games: [2, 1] });
    expect(classifyPointChange(prev, next, ctx)).toEqual({ kind: "none", reason: "undo" });
  });

  it("refuses to narrate when too much happened between looks", () => {
    const prev = frame({ games: [2, 1] });
    const next = frame({ eventNumber: 30, games: [4, 1] });
    expect(classifyPointChange(prev, next, ctx)).toEqual({ kind: "none", reason: "too-much-changed" });
  });

  it("refuses to narrate after a long gap, like a tab that was hidden", () => {
    const next = frame({ eventNumber: 11, points: ["30", "0"] });
    expect(classifyPointChange(frame(), next, { observedGapMs: 90_000 })).toEqual({ kind: "none", reason: "stale" });
  });

  it("hands a finished match to the result animation instead of playing a beat", () => {
    const prev = frame({ sets: [0, 0], games: [5, 2], points: ["40", "0"] });
    const next = frame({ eventNumber: 11, sets: [1, 0], games: [0, 0], matchOver: true });
    expect(classifyPointChange(prev, next, ctx)).toEqual({ kind: "none", reason: "match-over" });
  });
});

/* ------------------------------------------------------------------ */
/* courtSlots                                                          */
/* ------------------------------------------------------------------ */

const NOW = Date.parse("2026-09-12T18:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

function match(over: Partial<Match>): Match {
  return {
    id: "m",
    tournament_id: "t",
    stage: "group",
    bracket_id: null,
    group_id: null,
    round_name: "R1",
    match_order: 1,
    court_id: "c1",
    scheduled_time: null,
    team_a_id: "a",
    team_b_id: "b",
    status: "scheduled",
    serving_team_id: null,
    winner_team_id: null,
    active_scoring_device_id: null,
    is_pending_sync: false,
    started_at: null,
    ended_at: null,
    created_at: ago(3600),
    updated_at: ago(0),
    ...over,
  } as Match;
}

describe("courtSlots", () => {
  it("keeps a court on screen even when nothing is happening on it", () => {
    expect(courtSlots(["c1"], [], NOW)).toEqual([{ courtId: "c1", kind: "idle", match: null }]);
  });

  it("shows a live match", () => {
    const m = match({ id: "live", status: "live", started_at: ago(60) });
    expect(courtSlots(["c1"], [m], NOW)[0]).toMatchObject({ kind: "live", match: { id: "live" } });
  });

  it("holds a just-confirmed result instead of dropping it on the next poll", () => {
    // The old screen only rendered live matches, so this card vanished.
    const done = match({ id: "done", status: "completed", ended_at: ago(5) });
    expect(courtSlots(["c1"], [done], NOW)[0]).toMatchObject({ kind: "hold", match: { id: "done" } });
  });

  it("the hold outranks a match that starts straight after on the same court", () => {
    const done = match({ id: "done", status: "completed", ended_at: ago(5) });
    const next = match({ id: "next", status: "live", started_at: ago(2) });
    expect(courtSlots(["c1"], [done, next], NOW)[0].match?.id).toBe("done");
  });

  it("gives the court to the live match once the hold is over", () => {
    const done = match({ id: "done", status: "completed", ended_at: ago(20) });
    const next = match({ id: "next", status: "live", started_at: ago(10) });
    expect(courtSlots(["c1"], [done, next], NOW)[0]).toMatchObject({ kind: "live", match: { id: "next" } });
  });

  it("shows a recent result stilled, then the next fixture, then idle", () => {
    const done = match({ id: "done", status: "completed", ended_at: ago(60) });
    expect(courtSlots(["c1"], [done], NOW)[0].kind).toBe("rest");

    const old = match({ id: "old", status: "completed", ended_at: ago(3_600) });
    const upcoming = match({ id: "up", status: "scheduled", match_order: 4 });
    expect(courtSlots(["c1"], [old, upcoming], NOW)[0]).toMatchObject({ kind: "next", match: { id: "up" } });
  });

  it("covers walkovers, retirements and disqualifications, not just completed matches", () => {
    for (const status of ["walkover", "retired", "disqualified"] as const) {
      const m = match({ id: status, status, ended_at: ago(3) });
      expect(courtSlots(["c1"], [m], NOW)[0].kind).toBe("hold");
    }
  });

  it("scopes every hold to its own court", () => {
    // One court finishing must never pull another court's card onto its result.
    const c1 = match({ id: "c1-live", court_id: "c1", status: "live", started_at: ago(30) });
    const c2 = match({ id: "c2-done", court_id: "c2", status: "completed", ended_at: ago(2) });
    const slots = courtSlots(["c1", "c2"], [c1, c2], NOW);
    expect(slots.map((s) => [s.courtId, s.kind])).toEqual([
      ["c1", "live"],
      ["c2", "hold"],
    ]);
  });

  it("orders the next fixture by time, then by match order", () => {
    const later = match({ id: "later", scheduled_time: ago(-600), match_order: 1 });
    const sooner = match({ id: "sooner", scheduled_time: ago(-60), match_order: 9 });
    const unscheduled = match({ id: "unsched", scheduled_time: null, match_order: 0 });
    expect(courtSlots(["c1"], [later, unscheduled, sooner], NOW)[0].match?.id).toBe("sooner");
  });

  it("ignores cancelled matches", () => {
    const m = match({ id: "x", status: "cancelled" });
    expect(courtSlots(["c1"], [m], NOW)[0].kind).toBe("idle");
  });
});

/* ------------------------------------------------------------------ */
/* layout                                                              */
/* ------------------------------------------------------------------ */

import {
  GUTTER,
  LEADERBOARD_MAX_PX,
  LEADERBOARD_MIN_PX,
  MIN_TEXT,
  ROWS,
  STAGE,
  TYPE,
  fitFontSize,
  isTall,
  leaderboardPlan,
  numeralWidth,
  planGrid,
  showsAt,
} from "./layout";

describe("planGrid", () => {
  it("fits four courts as 930x420 cards — the design target", () => {
    const plan = planGrid(4);
    expect(plan).toMatchObject({ density: "grid", columns: 2, rows: 2, spareCells: 0 });
    expect(plan.cardWidth).toBe(930);
    expect(plan.cardHeight).toBe(430);
  });

  it("never lets the cards overflow the stage or the pinned content row", () => {
    for (let n = 1; n <= 6; n++) {
      const p = planGrid(n);
      expect(p.cardWidth * p.columns + GUTTER * (p.columns - 1)).toBeLessThanOrEqual(STAGE.width - GUTTER * 2);
      expect(p.cardHeight * p.rows + GUTTER * (p.rows - 1)).toBeLessThanOrEqual(ROWS.content);
    }
  });

  it("leaves a spare cell for three courts rather than stretching them", () => {
    expect(planGrid(3)).toMatchObject({ columns: 2, rows: 2, spareCells: 1 });
  });

  it("gives one court the whole stage and two courts half each", () => {
    expect(planGrid(1).density).toBe("hero");
    expect(planGrid(2)).toMatchObject({ density: "wide", columns: 2, rows: 1 });
  });

  it("drops to scoreboard density past four courts", () => {
    expect(planGrid(5).density).toBe("dense");
    expect(planGrid(6)).toMatchObject({ columns: 3, rows: 2, spareCells: 0 });
  });

  it("the header, content and ticker rows fill the stage exactly", () => {
    expect(ROWS.header + ROWS.content + ROWS.ticker).toBe(STAGE.height);
  });
});

describe("type sizes", () => {
  it("never go below the 22px legibility floor at any density", () => {
    for (const sizes of Object.values(TYPE)) {
      for (const [key, px] of Object.entries(sizes)) {
        if (key === "photo") continue;
        expect(px).toBeGreaterThanOrEqual(MIN_TEXT);
      }
    }
  });

  it("the dense grid drops photos and the entrance, but never the score", () => {
    expect(showsAt("dense")).toEqual({ photos: false, entrance: false, resultAnimation: false, fullNames: false });
    expect(TYPE.dense.points).toBeGreaterThanOrEqual(MIN_TEXT);
    expect(showsAt("grid").photos).toBe(true);
  });
});

describe("nothing on a scoreboard is clipped", () => {
  it("a two-digit point needs more room than the old fixed 150px box at wide density", () => {
    // The bug this replaced: "30" at 150px type was cut in half on a two-court wall.
    expect(numeralWidth(2, TYPE.wide.points)).toBeGreaterThan(150);
  });

  it("scales with the digits and the size", () => {
    expect(numeralWidth(1, 100)).toBeLessThan(numeralWidth(2, 100));
    expect(numeralWidth(2, 50)).toBeLessThan(numeralWidth(2, 100));
    expect(numeralWidth(0, 100)).toBe(numeralWidth(1, 100));
  });

  it("a whole scoreboard row fits the card it is drawn on", () => {
    for (const [density, plan] of ([["hero", planGrid(1)], ["wide", planGrid(2)], ["grid", planGrid(4)], ["dense", planGrid(6)]] as const)) {
      const t = TYPE[density];
      const row =
        numeralWidth(2, Math.round(t.games * 0.8)) + numeralWidth(2, t.games) + numeralWidth(2, t.points) + t.games;
      expect(row).toBeLessThan(plan.cardWidth);
    }
  });
});

describe("fitFontSize", () => {
  it("leaves a short name at the size it was given", () => {
    expect(fitFontSize("Team A", 600, 48)).toBe(48);
  });

  it("shrinks a long name rather than cutting it", () => {
    expect(fitFontSize("Sporting Club de Zamalek Padel", 300, 48)).toBeLessThan(48);
  });

  it("never goes below the legibility floor, however long the name", () => {
    expect(fitFontSize("x".repeat(400), 200, 48)).toBe(MIN_TEXT);
  });

  it("honours a lower floor when one is given, for a name plate", () => {
    expect(fitFontSize("x".repeat(400), 200, 30, 14)).toBe(14);
  });
});

describe("tall cards", () => {
  it("are the one- and two-court layouts, which have 880 pixels of height to use", () => {
    expect(isTall("hero")).toBe(true);
    expect(isTall("wide")).toBe(true);
    expect(isTall("grid")).toBe(false);
    expect(isTall("dense")).toBe(false);
    expect(planGrid(2).cardHeight).toBeGreaterThan(600);
  });
});

describe("leaderboardPlan", () => {
  it("gives one group the whole stage and big type", () => {
    const plan = leaderboardPlan([4]);
    expect(plan).toMatchObject({ columns: 1, rows: 1 });
    expect(plan.fontPx).toBe(LEADERBOARD_MAX_PX);
    expect(plan.detail).toBe(true);
  });

  it("clears the reading floor at every realistic number of groups, unlike the old fixed 14px", () => {
    for (const groups of [[4], [4, 3], [4, 3, 1], [4, 4, 4, 4], [3, 3, 3, 3, 3, 3]]) {
      expect(leaderboardPlan(groups).fontPx).toBeGreaterThanOrEqual(MIN_TEXT);
    }
  });

  it("shrinks as tables and teams are added, and never past the floor", () => {
    const three = leaderboardPlan([4, 4, 4]).fontPx;
    const six = leaderboardPlan([6, 6, 6, 6, 6, 6]).fontPx;
    expect(six).toBeLessThan(three);
    expect(six).toBeGreaterThanOrEqual(LEADERBOARD_MIN_PX);
  });

  it("keeps the set and game columns only for a table with the whole stage", () => {
    expect(leaderboardPlan([4]).detail).toBe(true);
    expect(leaderboardPlan([4, 4]).detail).toBe(false);
    expect(leaderboardPlan([4, 4, 4, 4, 4, 4]).detail).toBe(false);
  });

  it("never lets its cards overflow the stage or the content row", () => {
    for (let n = 1; n <= 8; n++) {
      const p = leaderboardPlan(Array.from({ length: n }, () => 4));
      expect(p.cardWidth * p.columns + GUTTER * (p.columns - 1)).toBeLessThanOrEqual(STAGE.width - GUTTER * 2);
      expect(p.cardHeight * p.rows + GUTTER * (p.rows - 1)).toBeLessThanOrEqual(ROWS.content);
    }
  });

  it("the tallest table decides the size, so every table matches", () => {
    expect(leaderboardPlan([2, 9]).fontPx).toBe(leaderboardPlan([9, 9]).fontPx);
  });
});

/* ------------------------------------------------------------------ */
/* entrance rank chip                                                  */
/* ------------------------------------------------------------------ */

import { entranceRankFor, ordinal, sessionRankFor, type EntranceContext } from "./entrance";

describe("ordinal", () => {
  it("handles the teens and the twenties", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st",
    ]);
  });
});

describe("entranceRankFor", () => {
  const ctx: EntranceContext = {
    standings: [
      { team_id: "falcons", group_id: "gA", rank: 2, points: 7 },
      { team_id: "eagles", group_id: "gB", rank: 1, points: 9 },
    ],
    groupNames: new Map([["gA", "Group A"], ["gB", "Group B"]]),
    matches: [
      {
        id: "qf1",
        stage: "quarter_final",
        status: "completed",
        bracket_id: "cup",
        round_name: "QF1",
        team_a_id: "falcons",
        team_b_id: "hawks",
        winner_team_id: "falcons",
        ended_at: "2026-09-12T17:00:00Z",
      },
    ],
    completedSets: new Map([["qf1", [{ teamAGames: 6, teamBGames: 4 }]]]),
    teamNames: new Map([["hawks", "Hawks"], ["falcons", "Falcons"]]),
  };

  it("shows a group match team's place in its group", () => {
    const m = { id: "g1", stage: "group" as const, bracket_id: null, round_name: "Group A Round 2", ended_at: null };
    expect(entranceRankFor(m, "falcons", ctx)).toBe("2nd · 7 pts");
  });

  it("shows the path through a knockout: the round and the last win with its score", () => {
    const sf = { id: "sf1", stage: "semi_final" as const, bracket_id: "cup", round_name: "SF1", ended_at: null };
    expect(entranceRankFor(sf, "falcons", ctx)).toBe("SF · beat Hawks 6-4");
  });

  it("falls back to the group finish in the first knockout round, since there is no seed", () => {
    const qf = { id: "qf2", stage: "quarter_final" as const, bracket_id: "cup", round_name: "QF2", ended_at: null };
    expect(entranceRankFor(qf, "eagles", ctx)).toBe("QF · 1st in Group B");
  });

  it("never borrows a win from the other bracket", () => {
    // Falcons won a Cup quarter-final; a Plate match must not claim it.
    const plateSf = { id: "psf", stage: "semi_final" as const, bracket_id: "plate", round_name: "Plate SF1", ended_at: null };
    expect(entranceRankFor(plateSf, "falcons", ctx)).toBe("Plate SF · 2nd in Group A");
  });

  it("scores from the winner's side of the net", () => {
    const flipped: EntranceContext = {
      ...ctx,
      matches: [{ ...ctx.matches[0], team_a_id: "hawks", team_b_id: "falcons" }],
      completedSets: new Map([["qf1", [{ teamAGames: 4, teamBGames: 6 }]]]),
    };
    const sf = { id: "sf1", stage: "semi_final" as const, bracket_id: "cup", round_name: "SF1", ended_at: null };
    expect(entranceRankFor(sf, "falcons", flipped)).toBe("SF · beat Hawks 6-4");
  });

  it("says nothing rather than inventing a standing", () => {
    const m = { id: "g1", stage: "group" as const, bracket_id: null, round_name: "R1", ended_at: null };
    expect(entranceRankFor(m, "nobody", ctx)).toBeNull();
  });
});

describe("sessionRankFor", () => {
  it("reads a session ranking", () => {
    expect(sessionRankFor(3, 12)).toBe("3rd · 12 pts");
    expect(sessionRankFor(null, 12)).toBeNull();
  });
});
