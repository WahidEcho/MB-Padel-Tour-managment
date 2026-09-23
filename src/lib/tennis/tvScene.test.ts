import { describe, it, expect } from "vitest";
import { callout, courtScene, tieScore, WALKON, type SceneRubber, type SceneTie } from "./tvScene";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../scoring/engine";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";
import { scoringConfigForMatch } from "../scoring/rules";

const T0 = Date.parse("2026-11-02T09:30:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const tie: SceneTie = { id: "t1", court_id: "c1", tie_order: 1, team_a_id: "USA", team_b_id: "ROU" };
const tie2: SceneTie = { id: "t2", court_id: "c1", tie_order: 2, team_a_id: "JPN", team_b_id: "EGY" };
const rubber = (no: number, over: Partial<SceneRubber> = {}): SceneRubber => ({
  id: `r${no}`, tie_id: "t1", rubber_no: no, rubber_type: (["S2", "S1", "D"] as const)[no - 1], court_id: "c1",
  status: "scheduled", started_at: null, ended_at: null, winner_team_id: null, team_a_id: "USA", team_b_id: "ROU", last_event_number: 0, ...over,
});

describe("court scene", () => {
  it("shows the next tie's line-up before play", () => {
    expect(courtScene("c1", [tie, tie2], [rubber(1), rubber(2), rubber(3)], T0)).toEqual({ kind: "lineup", tieId: "t1" });
  });
  it("walks each player on as a rubber starts, then goes to the score", () => {
    const rs = [rubber(1, { status: "live", started_at: at(0), last_event_number: 1 }), rubber(2), rubber(3)];
    expect(courtScene("c1", [tie], rs, T0 + 2_000)).toMatchObject({ kind: "walkon", side: "A", elapsedMs: 2_000 });
    expect(courtScene("c1", [tie], rs, T0 + WALKON.perSideMs + 500)).toMatchObject({ kind: "walkon", side: "B", elapsedMs: 500 });
    expect(courtScene("c1", [tie], rs, T0 + WALKON.totalMs + 1)).toEqual({ kind: "live", tieId: "t1", matchId: "r1" });
  });
  it("a point scored cuts the walk-on short", () => {
    const rs = [rubber(1, { status: "live", started_at: at(0), last_event_number: 2 })];
    expect(courtScene("c1", [tie], rs, T0 + 1_000).kind).toBe("live");
  });
  it("an operator's replay walks them on again until the next point", () => {
    const rs = [rubber(1, { status: "live", started_at: at(0), last_event_number: 40 })];
    const replay = { match_id: "r1", at: at(600_000), event_number: 40 };
    expect(courtScene("c1", [tie], rs, T0 + 603_000, replay)).toMatchObject({ kind: "walkon", side: "A" });
    const moved = [rubber(1, { status: "live", started_at: at(0), last_event_number: 41 })];
    expect(courtScene("c1", [tie], moved, T0 + 603_000, replay).kind).toBe("live");
  });
  it("a finished rubber is celebrated, then the tie score holds between rubbers", () => {
    const rs = [rubber(1, { status: "completed", started_at: at(0), ended_at: at(5_000_000), winner_team_id: "USA" }), rubber(2), rubber(3)];
    expect(courtScene("c1", [tie], rs, T0 + 5_004_000)).toMatchObject({ kind: "rubber_won", matchId: "r1" });
    expect(courtScene("c1", [tie], rs, T0 + 5_100_000)).toEqual({ kind: "tie_score", tieId: "t1", final: false });
  });
  it("a finished tie holds its final score, then the next tie's line-up", () => {
    const done = { status: "completed", started_at: at(0), ended_at: at(9_000_000), winner_team_id: "USA" };
    const rs = [rubber(1, done), rubber(2, done), rubber(3, { status: "cancelled" }), { ...rubber(1), id: "x1", tie_id: "t2", team_a_id: "JPN", team_b_id: "EGY" }];
    expect(courtScene("c1", [tie, tie2], rs, T0 + 9_060_000)).toEqual({ kind: "tie_score", tieId: "t1", final: true });
    expect(courtScene("c1", [tie, tie2], rs, T0 + 9_000_000 + 6 * 60_000)).toEqual({ kind: "lineup", tieId: "t2" });
  });
  it("another court's rubbers never reach this wall", () => {
    const rs = [rubber(1, { status: "live", started_at: at(0), court_id: "c2", last_event_number: 9 })];
    expect(courtScene("c1", [], rs, T0 + 60_000)).toEqual({ kind: "idle" });
  });
  it("counts the tie score from finished rubbers", () => {
    const rs = [rubber(1, { status: "completed", winner_team_id: "ROU" }), rubber(2, { status: "retired", winner_team_id: "USA" }), rubber(3, { status: "live" })];
    expect(tieScore(rs, "USA")).toEqual([1, 1]);
  });
});

describe("callouts", () => {
  const t = { sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG };
  const singles = scoringConfigForMatch(t, { stage: "group" });
  const doubles = scoringConfigForMatch(t, { stage: "group" }, null, { doubles: true });
  const pts = (s: ScoreState, k: TeamKey, n: number, cfg = singles) => {
    for (let i = 0; i < n; i++) s = awardPoint(s, k, cfg);
    return s;
  };
  it("break point when the receiver is a point from the game", () => {
    const s = pts(initialScoreState("A"), "B", 3);
    expect(callout(s, singles)).toBe("Break point");
    expect(callout(pts(initialScoreState("A"), "A", 3), singles)).toBeNull();
  });
  it("set point, then match point", () => {
    let s = initialScoreState("A");
    for (let g = 0; g < 5; g++) s = pts(s, "A", 4); // 5-0
    s = pts(s, "A", 3); // 40-0 for the set
    expect(callout(s, singles)).toBe("Set point");
    s = pts(s, "A", 1); // 6-0
    for (let g = 0; g < 5; g++) s = pts(s, "A", 4); // 6-0 5-0
    s = pts(s, "A", 3);
    expect(callout(s, singles)).toBe("Match point");
  });
  it("deciding point at deuce under no-ad", () => {
    let s = pts(initialScoreState("A"), "A", 3, doubles);
    s = pts(s, "B", 3, doubles);
    expect(callout(s, doubles)).toBe("Deciding point");
  });
  it("names the tie-break at its first point", () => {
    let s = initialScoreState("A");
    for (let g = 0; g < 6; g++) s = pts(pts(s, "A", 4), "B", 4);
    expect(s.isTiebreak).toBe(true);
    expect(callout(s, singles)).toBe("Tie-break");
  });
});
