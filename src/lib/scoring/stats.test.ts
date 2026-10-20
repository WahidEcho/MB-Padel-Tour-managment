/**
 * Match and tie stats from stored score events (stats.ts): events are recorded the
 * way the consoles record them (console.ts), with the state before and after each.
 */
import { describe, expect, it } from "vitest";
import * as C from "./console";
import { initialScoreState, type ScoreState, type TeamKey } from "./engine";
import { scoringConfigForMatch } from "./rules";
import { computeMatchStats, durationText, effectiveEvents, statLines, swapSides, tieStats, type MatchStats, type StatsEventRow } from "./stats";
import { DEFAULT_TENNIS_SCORING_CONFIG, type ScoringConfig } from "../types";

const singles = scoringConfigForMatch({ sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG }, { stage: "group" });
const doubles = scoringConfigForMatch({ sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG }, { stage: "group" }, null, { doubles: true });
const TEAM = { A: "team-a", B: "team-b" };
const T0 = Date.parse("2026-10-20T10:00:00Z");

type Step = TeamKey | "ace" | "fault" | "undo" | "let" | "timer" | "violation";

/** Plays steps like a console and returns the stored rows plus the final state. One step every 30 s. */
function play(steps: Step[], config: ScoringConfig = singles, start: ScoreState = initialScoreState("A")) {
  const o: C.ConsoleOptions = { config, confirmFirst: false, online: true, tennis: true, doubles: false };
  let cur = start;
  let history: ScoreState[] = [];
  const rows: StatsEventRow[] = [];
  let n = 1;
  for (const s of steps) {
    const e =
      s === "A" || s === "B"
        ? C.point(cur, s, o)
        : s === "ace"
          ? C.aceEvent(cur, o)
          : s === "fault"
            ? C.faultEvent(cur, o)
            : s === "let"
              ? C.letEvent(cur, "serve")
              : s === "timer"
                ? C.timerStart(cur, "between_points", new Date(T0).toISOString())
                : s === "violation"
                  ? C.violation(cur, "A", "ball_abuse", o)
                  : C.undo(history, false);
    if (!e) throw new Error(`console refused ${s}`);
    rows.push({
      event_number: n,
      event_type: e.eventType,
      team_id: e.team ? TEAM[e.team] : null,
      payload: e.payload,
      prev: cur,
      at: new Date(T0 + (n - 1) * 30_000).toISOString(),
    });
    n += 1;
    history = C.nextHistory(history, cur, e.eventType);
    cur = e.next;
  }
  return { rows, final: cur };
}

const stats = (rows: StatsEventRow[], final: ScoreState | null, config = singles, showAces = true) => {
  const r = computeMatchStats(rows, { teamA: TEAM.A, teamB: TEAM.B, config, final, showAces });
  if (!r.available) throw new Error(`unavailable: ${r.reason}`);
  return r;
};

const game = (w: TeamKey): TeamKey[] => [w, w, w, w];

describe("match stats", () => {
  it("counts aces for the server and a double fault after two faults against the server", () => {
    const { rows, final } = play(["ace", "fault", "let", "fault", "ace", "fault", "B"]);
    const s = stats(rows, final);
    expect(s.sides.A.aces).toBe(2);
    expect(s.sides.B.aces).toBe(0);
    expect(s.sides.A.doubleFaults).toBe(1);
    expect(s.sides.B.doubleFaults).toBe(0);
    // ace, ace, double fault (to B), point B: A 2, B 2.
    expect(s.sides.A.pointsWon).toBe(2);
    expect(s.sides.B.pointsWon).toBe(2);
    expect(s.points).toBe(4);
    // A served all four.
    expect(s.sides.A.servicePointsPlayed).toBe(4);
    expect(s.sides.A.servicePointsWon).toBe(2);
    expect(s.sides.B.returnPointsPlayed).toBe(4);
    expect(s.sides.B.returnPointsWon).toBe(2);
  });

  it("omits aces when the organiser hides them", () => {
    const { rows, final } = play(["ace", "A"]);
    const s = stats(rows, final, singles, false);
    expect(s.aces).toBe(false);
    expect("aces" in s.sides.A).toBe(false);
    expect(statLines(s.sides).map((l) => l.key)).not.toContain("aces");
    expect(statLines(stats(rows, final).sides)[0].key).toBe("aces");
  });

  it("finds break points at 30-40, at advantage receiver, and converts one", () => {
    // A serves: 0-15, 0-30, 15-30, 15-40, then break points at 15-40 and 30-40 (both saved), 40-40,
    // 40-AD, a break point (saved), deuce, 40-AD, a break point, won: game B.
    const { rows, final } = play(["B", "B", "A", "B", "A", "A", "B", "A", "B", "B"]);
    const s = stats(rows, final);
    expect(s.sides.B.breakPointChances).toBe(4);
    expect(s.sides.B.breakPointsWon).toBe(1);
    expect(s.sides.A.breakPointChances).toBe(0);
    expect(s.sides.B.gamesWon).toBe(1);
    expect(s.sides.A.gamesWon).toBe(0);
    expect(statLines(s.sides).find((l) => l.key === "breakPoints")).toMatchObject({ a: "0/0", b: "1/4", lead: "B" });
  });

  it("at a no-ad deciding point, deuce is a break point; with advantage it is not", () => {
    const toDeuce: TeamKey[] = ["A", "B", "A", "B", "A", "B"];
    // 15-0, 15-15, 30-15, 30-30, 40-30, 40-40: no break point before deuce.
    const ad = play([...toDeuce, "A"]);
    expect(stats(ad.rows, ad.final).sides.B.breakPointChances).toBe(0);
    const noAd = play([...toDeuce, "B"], doubles);
    const s = stats(noAd.rows, noAd.final, doubles);
    // The deciding point at 40-40, converted.
    expect(s.sides.B.breakPointChances).toBe(1);
    expect(s.sides.B.breakPointsWon).toBe(1);
    expect(s.sides.B.gamesWon).toBe(1);
  });

  it("never counts a tie-break point as a break point", () => {
    // Twelve holds to 6-6, then a tie-break the receiver of each point wins.
    const holds: TeamKey[] = [];
    for (let g = 0; g < 12; g++) holds.push(...game(g % 2 === 0 ? "A" : "B"));
    const { rows, final } = play([...holds, "B", "A", "B", "B", "A", "B", "B"]);
    expect(final.isTiebreak).toBe(true);
    const s = stats(rows, final);
    expect(s.sides.A.breakPointChances + s.sides.B.breakPointChances).toBe(0);
    // Tie-break serve rotates: B and A both served points in it.
    expect(s.sides.A.servicePointsPlayed + s.sides.B.servicePointsPlayed).toBe(s.points);
    expect(s.sides.A.gamesWon).toBe(6);
    expect(s.sides.B.gamesWon).toBe(6);
  });

  it("leaves out a point taken back by Undo, and keeps timers and lets out of the undo stack", () => {
    const { rows, final } = play(["A", "ace", "timer", "undo", "B"]);
    const s = stats(rows, final);
    expect(s.sides.A.aces).toBe(0);
    expect(s.sides.A.pointsWon).toBe(1);
    expect(s.sides.B.pointsWon).toBe(1);
    expect(effectiveEvents(rows).map((r) => r.event_number)).toEqual([1, 3, 5]);
  });

  it("an Undo of a double fault takes the double fault back", () => {
    const { rows, final } = play(["fault", "fault", "undo"]);
    const r = computeMatchStats(rows, { teamA: TEAM.A, teamB: TEAM.B, config: singles, final, showAces: true });
    expect(r).toMatchObject({ available: false, reason: "no_points" });
  });

  it("longest run of points, and points won", () => {
    const { rows, final } = play(["A", "A", "B", "A", "A", "A", "A", "B", "B"]);
    const s = stats(rows, final);
    expect(s.sides.A.longestRun).toBe(4);
    expect(s.sides.B.longestRun).toBe(2);
    expect(s.sides.A.pointsWon).toBe(6);
    expect(s.sides.B.pointsWon).toBe(3);
  });

  it("a penalty point is not a point played", () => {
    const { rows, final } = play(["A", "violation", "violation", "B"]);
    const s = stats(rows, final);
    expect(s.points).toBe(2);
  });

  it("match length from first to last point, and each set's length", () => {
    // A wins six games straight: A holds and breaks.
    const six = Array.from({ length: 6 }, () => game("A")).flat();
    const { rows, final } = play([...six, "B", "B"]);
    const s = stats(rows, final);
    expect(s.durationSeconds).toBe(25 * 30);
    expect(s.sets.map((x) => x.label)).toEqual(["Set 1", "Set 2"]);
    expect(s.sets[0].seconds).toBe(23 * 30);
    expect(s.sets[1].seconds).toBe(30);
    expect(s.sides.A.gamesWon).toBe(6);
    expect(s.sides.A.breakPointsWon).toBe(3);
    expect(s.sides.A.breakPointChances).toBe(3);
    expect(durationText(s.durationSeconds)).toBe("13m");
    expect(durationText(5040)).toBe("1h 24m");
    expect(durationText(null)).toBe("—");
  });

  it("counts games from the points when no final state is given", () => {
    const { rows } = play([...game("A"), ...game("B"), "A"]);
    const s = stats(rows, null);
    expect(s.sides.A.gamesWon).toBe(1);
    expect(s.sides.B.gamesWon).toBe(1);
  });

  it("a result entered as a final score has no stats: recorded point by point only", () => {
    const { rows, final } = play(["A", "B"]);
    const entered = [...rows.map((r) => ({ ...r, superseded: true })), { event_number: 3, event_type: "RESULT_ENTERED", team_id: TEAM.A, payload: { sets: [] }, prev: final, at: null }];
    const r = computeMatchStats(entered, { teamA: TEAM.A, teamB: TEAM.B, config: singles, final, showAces: true });
    expect(r).toMatchObject({ available: false, reason: "final_score" });
    if (!r.available) expect(r.note).toMatch(/point by point only/);
    expect(computeMatchStats(rows, { teamA: TEAM.A, teamB: TEAM.B, config: singles, final, showAces: true, resultSource: "final_score" })).toMatchObject({ available: false, reason: "final_score" });
  });

  it("works from a projected previous state (only the fields the server selects)", () => {
    const { rows, final } = play(["B", "B", "B", "B"]);
    const projected = rows.map((r) => {
      const p = r.prev as ScoreState;
      return { ...r, prev: { teamA: p.teamA, teamB: p.teamB, isTiebreak: p.isTiebreak, servingTeam: p.servingTeam, currentSet: p.currentSet } };
    });
    expect(stats(projected, final)).toEqual(stats(rows, final));
  });
});

describe("tie stats", () => {
  it("sums its rubbers on the tie's sides and adds the time on court", () => {
    const r1 = play(["ace", "A", "B"]);
    const r2 = play(["ace", "ace", "B", "fault", "fault"]);
    const s1 = stats(r1.rows, r1.final);
    // The second rubber lists the tie's B team as its side A.
    const s2 = swapSides(stats(r2.rows, r2.final)) as MatchStats;
    const t = tieStats(
      [
        { matchId: "m1", rubberNo: 1, rubberType: "S2", stats: s1 },
        { matchId: "m2", rubberNo: 2, rubberType: "S1", stats: s2 },
        { matchId: "m3", rubberNo: 3, rubberType: "D", stats: computeMatchStats([], { teamA: TEAM.A, teamB: TEAM.B, config: doubles, showAces: true, resultSource: "final_score" }) },
      ],
      true,
    );
    expect(t.available).toBe(true);
    expect(t.counted).toBe(2);
    expect(t.sides!.A.aces).toBe(1);
    expect(t.sides!.B.aces).toBe(2);
    expect(t.sides!.A.doubleFaults).toBe(0);
    expect(t.sides!.B.doubleFaults).toBe(1);
    expect(t.sides!.A.pointsWon).toBe(2 + 2);
    expect(t.timeOnCourtSeconds).toBe(60 + 120);
    expect(t.note).toMatch(/final score/);
  });

  it("no rubber recorded point by point: unavailable", () => {
    const t = tieStats([{ matchId: "m", rubberNo: 1, rubberType: "S1", stats: computeMatchStats([], { teamA: "a", teamB: "b", config: singles, showAces: true, resultSource: "final_score" }) }], true);
    expect(t).toMatchObject({ available: false, sides: null, counted: 0 });
    expect(t.note).toMatch(/point by point only/);
  });
});
