import { describe, expect, it } from "vitest";
import { GAME_HOLD_MS, MOMENTUM_POINTS, boardStep, momentumGeometry, statBoxes, type BoardMemory, type BoardMode } from "./board";
import { overlayModel, overlayMoment, type OverlayInput, type OverlayMatchInfo, type OverlayModel } from "./overlay";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../scoring/engine";
import { pointWinners, type StatsEventRow } from "../scoring/stats";
import { startClock } from "../scoring/timing";
import { scoringConfigForMatch } from "../scoring/rules";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";
import type { LiveMatch, LiveSnapshot } from "../tv/liveFeed";

const T0 = Date.parse("2026-10-22T10:00:00Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const rules = scoringConfigForMatch({ sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG }, { stage: "group" });
const doublesRules = scoringConfigForMatch({ sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG }, { stage: "group" }, null, { doubles: true });

const play = (points: TeamKey[], from = initialScoreState("A"), r = rules): ScoreState => points.reduce((s, p) => awardPoint(s, p, r), from);
const games = (team: TeamKey, n: number): TeamKey[] => Array.from({ length: n * 4 }, () => team);

const snapOf = (s: ScoreState, n: number): LiveSnapshot => ({
  match_id: "m1", last_event_number: n, last_undo_event_number: 0,
  points: [s.teamA.points, s.teamB.points], games: [s.teamA.games, s.teamB.games], sets: [s.teamA.sets, s.teamB.sets],
  tiebreak: s.isTiebreak, match_tiebreak: Boolean(s.isMatchTiebreak), tiebreak_points: [s.teamA.tiebreakPoints, s.teamB.tiebreakPoints],
  serving_team_id: s.servingTeam === "A" ? "EGY" : s.servingTeam === "B" ? "AUT" : null, completed_sets: s.completedSets, match_over: s.matchOver,
  ...(s.matchOver ? {} : { state: s }),
});
const info = (r = rules): OverlayMatchInfo => ({ id: "m1", tie_id: null, rubber_no: null, rubber_type: null, a: [], b: [], round_name: "Boys' Doubles SF", rules: r });
const input = (s: ScoreState, n: number, over: Partial<OverlayInput> = {}, status: LiveMatch["status"] = "live"): OverlayInput => ({
  courtId: "c3",
  courtName: "Court 3",
  title: "J200 Cairo",
  matches: [{
    id: "m1", status, stage: "semi_final", court_id: "c3", bracket_id: null, round_name: "Boys' Doubles SF", match_order: 1, scheduled_time: null,
    team_a_id: "EGY", team_b_id: "AUT", winner_team_id: status === "completed" ? "EGY" : null, started_at: iso(0), ended_at: status === "completed" ? iso(3_600_000) : null,
  }],
  snapshots: [snapOf(s, n)],
  info: { m1: info() },
  teams: {
    EGY: { id: "EGY", code: "EGY", iso2: "eg", name: "Genidy / Mourid", players: [{ id: "p1", name: "Youssef Mourid" }, { id: "p2", name: "Mohamed Genidy" }] },
    AUT: { id: "AUT", code: "AUT", iso2: "at", name: "Niedermayr / Raser", players: [{ id: "p3", name: "Gabriel Niedermayr" }, { id: "p4", name: "Felix Raser" }] },
  },
  ties: [],
  now: T0 + 3_700_000,
  switches: { aces: true, timers: true },
  timeZone: "Africa/Cairo",
  ...over,
});

/** Feeds the board one frame after another, the way the overlay does. */
function run(frames: { model: OverlayModel; at: number }[]): BoardMode[] {
  let memory: BoardMemory | null = null;
  return frames.map(({ model, at }) => {
    const step = boardStep(memory, model, at);
    memory = step.memory;
    return step.mode;
  });
}

describe("board mode: compact while play is on, full between games and at the end", () => {
  const s0 = play(["A", "A"]); // 30-0 in the first game
  const won = play([...games("A", 1)]); // 1-0, 0-0
  const next = play([...games("A", 1), "B"]); // 1-0, 0-15

  it("compact mid-game; a game won → full; the next point → compact", () => {
    const at = T0 + 1_000_000;
    const modes = run([
      { model: overlayModel(input(s0, 3)), at },
      { model: overlayModel(input(won, 5)), at: at + 5_000 },
      { model: overlayModel(input(won, 5)), at: at + 10_000 },
      { model: overlayModel(input(next, 6)), at: at + 12_000 },
    ]);
    expect(modes).toEqual(["compact", "full", "full", "compact"]);
  });

  it("with no timer the full board lasts GAME_HOLD_MS, then goes back to compact", () => {
    const at = T0 + 1_000_000;
    const modes = run([
      { model: overlayModel(input(s0, 3)), at },
      { model: overlayModel(input(won, 5)), at: at + 1_000 },
      { model: overlayModel(input(won, 5)), at: at + 1_000 + GAME_HOLD_MS - 1 },
      { model: overlayModel(input(won, 5)), at: at + 1_000 + GAME_HOLD_MS + 1 },
    ]);
    expect(modes).toEqual(["compact", "full", "full", "compact"]);
  });

  it("a changeover timer keeps it full until the timer ends or the next point", () => {
    const at = T0 + 1_000_000;
    const timed = startClock(won, "changeover", iso(1_000_000 + 2_000));
    const frames = (now: number) => overlayModel(input(timed, 6, { now }));
    const modes = run([
      { model: overlayModel(input(s0, 3, { now: at })), at },
      { model: overlayModel(input(won, 5, { now: at + 1_000 })), at: at + 1_000 },
      // 60 s into the 90 s changeover: still full, past the 20 s hold.
      { model: frames(at + 62_000), at: at + 62_000 },
      { model: overlayModel(input(next, 7, { now: at + 70_000 })), at: at + 70_000 },
    ]);
    expect(modes).toEqual(["compact", "full", "full", "compact"]);
    const clock = overlayModel(input(timed, 6, { now: at + 62_000 }));
    expect(clock.kind === "live" && clock.clock).toMatchObject({ kind: "changeover", label: "Changeover", text: "1:00" });
  });

  it("a set break timer opens the full board even when the board opened mid-break", () => {
    const set = play(games("A", 6));
    const timed = startClock(set, "set_break", iso(1_000_000));
    const model = overlayModel(input(timed, 30, { now: T0 + 1_030_000 }));
    expect(model.kind === "live" && model.clock?.label).toBe("Set break");
    expect(run([{ model, at: T0 + 1_030_000 }])).toEqual(["full"]);
  });

  it("an undo that takes a game back is not a game won", () => {
    const at = T0 + 1_000_000;
    const back = play(["A", "A", "A"]);
    expect(run([
      { model: overlayModel(input(won, 5)), at },
      { model: overlayModel(input(back, 6)), at: at + 3_000 },
    ])).toEqual(["compact", "compact"]);
  });

  it("match over → full with the final score; idle and next → compact", () => {
    const done = play([...games("A", 6), ...games("A", 6)]);
    const fin = overlayModel(input(done, 49, {}, "completed"));
    expect(fin.kind).toBe("final");
    expect(fin.kind === "final" && fin.right).toBe("Final");
    expect(run([{ model: fin, at: T0 + 3_700_000 }])).toEqual(["full"]);
    const idle = overlayModel({ ...input(done, 49), matches: [] });
    expect(run([{ model: idle, at: T0 }])).toEqual(["compact"]);
  });
});

describe("the board's strip", () => {
  it("left: event · round · court; right: the moment with the side's code", () => {
    const v = overlayModel(input(play(["A", "A", "A"]), 3));
    if (v.kind !== "live") throw new Error(v.kind);
    expect(v.left).toEqual(["J200 Cairo", "Boys' Doubles SF", "Court 3"]);
    expect(v.rows.map((r) => r.surnames)).toEqual([["Genidy", "Mourid"], ["Niedermayr", "Raser"]]);
  });

  it("deuce, break point, set point, match point, tie-break, super tie-break", () => {
    const codes: [string, string] = ["EGY", "AUT"];
    // A serves the first game.
    expect(overlayMoment(play(["A", "A", "A", "B", "B", "B"]), rules, codes)).toBe("Deuce");
    expect(overlayMoment(play(["B", "B", "B"]), rules, codes)).toBe("Break point · AUT");
    expect(overlayMoment(play(["A", "A", "A"]), rules, codes)).toBe(null);
    expect(overlayMoment(play([...games("A", 5), "A", "A", "A"]), rules, codes)).toBe("Set point · EGY");
    expect(overlayMoment(play([...games("A", 6), ...games("A", 5), "A", "A", "A"]), rules, codes)).toBe("Match point · EGY");
    const tb = play(Array.from({ length: 6 }, () => [...games("A", 1), ...games("B", 1)]).flat());
    expect(overlayMoment(tb, rules, codes)).toBe("Tie-break");
    // Doubles: a super tie-break in place of the third set, deciding point at deuce.
    const split = play([...games("A", 6), ...games("B", 6)], initialScoreState("A"), doublesRules);
    expect(split.isMatchTiebreak).toBe(true);
    expect(overlayMoment(split, doublesRules, codes)).toBe("Super tie-break");
    expect(overlayMoment(play(["A", "A", "A", "B", "B", "B"], initialScoreState("A"), doublesRules), doublesRules, codes)).toBe("Deciding point");
  });

  it("a super tie-break draws its points in the pill and no games column", () => {
    const split = play([...games("A", 6), ...games("B", 6), "A", "B", "A"], initialScoreState("A"), doublesRules);
    const v = overlayModel({ ...input(split, 60), info: { m1: info(doublesRules) } });
    if (v.kind !== "live") throw new Error(v.kind);
    expect(v.label).toBe("Super TB");
    expect(v.right).toBe("Super tie-break");
    expect(v.rows.map((r) => r.points)).toEqual(["2", "1"]);
    expect(v.rows.map((r) => r.games)).toEqual([null, null]);
  });
});

describe("momentum line and stat boxes", () => {
  it("climbs for side A, drops for side B, over the last 40 points only", () => {
    const g = momentumGeometry(["A", "A", "B"], 520, 90, 7);
    expect(g.line).toBe("M0 45 L13 38 L26 31 L39 38");
    expect(g.last).toEqual([39, 38]);
    expect(g.area.endsWith("L39 45 L0 45 Z")).toBe(true);
    const long = momentumGeometry([...Array.from({ length: 50 }, () => "B" as const)]);
    expect(long.last[0]).toBe(520);
    // Forty points the same way: scaled to reach the box's edge, not flattened against it.
    expect(long.last[1]).toBe(84);
    expect(long.line.split(" L")[20]).toBe("260 64.5");
    expect(MOMENTUM_POINTS).toBe(40);
  });

  it("who won each counted point: undone and superseded points do not count", () => {
    const row = (n: number, type: string, team: string | null, extra: Partial<StatsEventRow> = {}): StatsEventRow => ({
      event_number: n, event_type: type, team_id: team, payload: null, prev: { teamA: {}, teamB: {} }, at: null, ...extra,
    });
    const rows = [row(1, "MATCH_STARTED", null), row(2, "POINT_AWARDED", "EGY"), row(3, "POINT_AWARDED", "AUT"), row(4, "UNDO", null), row(5, "POINT_AWARDED", "EGY"), row(6, "POINT_AWARDED", "AUT")];
    expect(pointWinners(rows, "EGY", "AUT")).toEqual(["A", "A", "B"]);
  });

  it("aces when the organiser shows them, double faults otherwise; breaks; points won", () => {
    const side = (aces: number | undefined, df: number, br: number, pw: number) => ({ ...(aces !== undefined ? { aces } : {}), doubleFaults: df, breaks: br, pointsWon: pw });
    expect(statBoxes({ aces: true, A: side(3, 1, 1, 31), B: side(2, 0, 1, 29) })).toEqual([
      { label: "Aces", a: 3, b: 2 },
      { label: "Breaks", a: 1, b: 1 },
      { label: "Points won", a: 31, b: 29 },
    ]);
    expect(statBoxes({ aces: false, A: side(undefined, 1, 0, 4), B: side(undefined, 2, 1, 6) })[0]).toEqual({ label: "Double faults", a: 1, b: 2 });
    expect(statBoxes(null)).toEqual([]);
  });
});
