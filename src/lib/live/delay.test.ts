import { describe, expect, it } from "vitest";
import { awardPoint, initialScoreState, type ScoreState } from "../scoring/engine";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Match, type MatchSnapshot, type Tie } from "../types";
import {
  MAX_SCORE_DELAY_SECONDS,
  cutoffFor,
  firstInWindow,
  lastUndoBefore,
  maskAdvancement,
  maskBracketSlots,
  maskTieAdvancement,
  matchAsOf,
  parseScoreDelayInput,
  sanitizeScoreDelay,
  sanitizeScoreDelaySeconds,
  scoreDelayNotice,
  scoreDelayPreview,
  scoreDelaySeconds,
  servingTeamIdOf,
  snapshotAsOf,
  snapshotNeedsRebuild,
  snapshotRowFromState,
  tiesAsOf,
  SCORE_ALERT_KINDS,
  type AsOfEvent,
} from "./delay";

const T0 = Date.parse("2026-11-02T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const M = { id: "m1", tournament_id: "t1", team_a_id: "A", team_b_id: "B" };

describe("the setting", () => {
  it("sanitises to whole seconds from 0 to 120; garbage is 0", () => {
    expect(sanitizeScoreDelaySeconds(30)).toBe(30);
    expect(sanitizeScoreDelaySeconds("45")).toBe(45);
    expect(sanitizeScoreDelaySeconds(12.6)).toBe(13);
    expect(sanitizeScoreDelaySeconds(500)).toBe(MAX_SCORE_DELAY_SECONDS);
    for (const bad of [-5, NaN, Infinity, "abc", "", null, undefined, {}, [], true]) expect(sanitizeScoreDelaySeconds(bad)).toBe(0);
    expect(sanitizeScoreDelay({ seconds: 30, updatedAt: "x" })).toEqual({ seconds: 30, updatedAt: "x" });
    expect(sanitizeScoreDelay("30")).toEqual({ seconds: 0 });
    expect(scoreDelaySeconds({ scoreDelay: { seconds: 60 } })).toBe(60);
    expect(scoreDelaySeconds(null)).toBe(0);
    expect(scoreDelaySeconds({})).toBe(0);
  });

  it("the meter's typed value is refused unless whole seconds in range", () => {
    expect(parseScoreDelayInput("30")).toEqual({ ok: true, seconds: 30 });
    expect(parseScoreDelayInput(" 0 ")).toEqual({ ok: true, seconds: 0 });
    expect(parseScoreDelayInput("120")).toEqual({ ok: true, seconds: 120 });
    for (const bad of ["121", "-1", "2.5", "ten", "", null]) expect(parseScoreDelayInput(bad).ok).toBe(false);
  });

  it("says what fans see", () => {
    expect(scoreDelayPreview(30)).toBe("Fans see scores 30 s after the referee records them.");
    expect(scoreDelayPreview(0)).toMatch(/^Off/);
    expect(scoreDelayNotice(30)).toBe("Scores are shown 30 s behind live.");
    expect(scoreDelayNotice(0)).toBeNull();
    expect(cutoffFor(T0, 30)).toBe(T0 - 30_000);
  });

  it("delays the alerts that tell how play goes, never the calls to court", () => {
    for (const k of ["match_live", "match_finished", "tie_decided", "coach_started", "coach_finished", "coach_tie_result"]) expect(SCORE_ALERT_KINDS.has(k)).toBe(true);
    for (const k of ["called_to_court", "call_reminder", "match_soon", "lineups", "announcement", "coach_called", "coach_soon", "coach_lineup", "tie_scheduled"]) expect(SCORE_ALERT_KINDS.has(k)).toBe(false);
  });
});

type Times = Pick<Match, "status" | "winner_team_id" | "started_at" | "ended_at"> & { serving_team_id?: string | null };

describe("a match as of the cutoff", () => {
  const cutoff = T0;
  it("started inside the window: not started yet", () => {
    const m: Times = { status: "live", winner_team_id: null, started_at: iso(T0 + 5_000), ended_at: null, serving_team_id: "A" };
    expect(matchAsOf(m, cutoff)).toEqual({ status: "scheduled", winner_team_id: null, started_at: null, ended_at: null, serving_team_id: null });
  });
  it("finished inside the window: still live, no winner", () => {
    const m: Times = { status: "completed", winner_team_id: "A", started_at: iso(T0 - 3_600_000), ended_at: iso(T0 + 1_000) };
    expect(matchAsOf(m, cutoff)).toMatchObject({ status: "live", winner_team_id: null, ended_at: null, started_at: m.started_at });
  });
  it("started and finished inside the window (a quick walkover): not started", () => {
    expect(matchAsOf({ status: "walkover", winner_team_id: "B", started_at: null, ended_at: iso(T0 + 2_000) }, cutoff).status).toBe("scheduled");
  });
  it("before the window: as stored", () => {
    const done: Times = { status: "completed", winner_team_id: "A", started_at: iso(T0 - 7_200_000), ended_at: iso(T0 - 1) };
    expect(matchAsOf(done, cutoff)).toBe(done);
    const sched: Times = { status: "scheduled", winner_team_id: null, started_at: null, ended_at: null };
    expect(matchAsOf(sched, cutoff)).toBe(sched);
  });
});

describe("snapshots as of the cutoff", () => {
  const rules = DEFAULT_TENNIS_SCORING_CONFIG;
  const s0 = initialScoreState("A");
  const s1 = awardPoint(s0, "A", rules);
  const s2 = awardPoint(s1, "A", rules);
  const ev = (n: number, type: string, state: ScoreState, at: number): AsOfEvent => ({ match_id: "m1", event_number: n, event_type: type, team_id: null, new_state_json: state, created_at_server: iso(at) });
  const current = { ...snapshotRowFromState(M, s2, 3, { lastEventType: "POINT_AWARDED" }, iso(T0 + 3_000)), id: "snap" } as MatchSnapshot;

  it("the mapper writes what ops.ts always wrote, the serving team by side", () => {
    const row = snapshotRowFromState(M, s1, 2, { lastEventType: "POINT_AWARDED", lastEventTeamId: "A", lastUndoEventNumber: 0 }, "x");
    expect(row).toMatchObject({ match_id: "m1", tournament_id: "t1", team_a_point_label: "15", team_b_point_label: "0", serving_team_id: "A", last_event_number: 2, last_event_type: "POINT_AWARDED", last_undo_event_number: 0, updated_at: "x" });
    expect(servingTeamIdOf(M, { servingTeam: "B" })).toBe("B");
    // A tie-break rotates the serve by point: the state names nobody, nor does the row.
    expect(servingTeamIdOf(M, { servingTeam: null })).toBeNull();
    const chess = snapshotRowFromState(M, { fen: "x", games: [] }, 4);
    expect(chess).toMatchObject({ team_a_point_label: "", serving_team_id: null, completed_sets: [] });
  });

  it("only snapshots changed after the cutoff are rebuilt", () => {
    expect(snapshotNeedsRebuild(current, T0)).toBe(true);
    expect(snapshotNeedsRebuild(current, T0 + 10_000)).toBe(false);
    expect(snapshotAsOf(M, current, undefined, null, 0)).toBe(current);
  });

  it("a point inside the window is not shown: the event before it is", () => {
    // Events 1 (start), 2 (15-0) before the cutoff, 3 (30-0) after it.
    const first = firstInWindow([{ match_id: "m1", event_number: 3 }]);
    expect(first.get("m1")).toBe(3);
    const asOf = snapshotAsOf(M, current, 3, ev(2, "POINT_AWARDED", s1, T0 - 1_000), 0)!;
    expect(asOf.team_a_point_label).toBe("15");
    expect(asOf.last_event_number).toBe(2);
    expect(asOf.updated_at).toBe(iso(T0 - 1_000));
    expect(asOf.id).toBe("snap");
  });

  it("a match whose first event is inside the window has no score yet", () => {
    expect(snapshotAsOf(M, current, 1, null, 0)).toBeNull();
    // The wrong row (not the one before the window) is never used.
    expect(snapshotAsOf(M, current, 3, ev(1, "MATCH_STARTED", s0, T0 - 5_000), 0)).toBeNull();
  });

  it("an UNDO: the state it went back to, and the undo watermark as it stood", () => {
    // 1 start, 2 point (15-0), 3 point (30-0), 4 UNDO → 15-0 (before the cutoff), 5 UNDO → 0-0 (inside the window).
    const undoBefore = ev(4, "UNDO", s1, T0 - 500);
    const now = { ...snapshotRowFromState(M, s0, 5, { lastEventType: "UNDO", lastUndoEventNumber: 5 }, iso(T0 + 2_000)) } as MatchSnapshot;
    const first = firstInWindow([{ match_id: "m1", event_number: 5 }]).get("m1")!;
    const undo = (now.last_undo_event_number ?? 0) < first ? now.last_undo_event_number! : lastUndoBefore([{ match_id: "m1", event_number: 4 }, { match_id: "m1", event_number: 5 }, { match_id: "x", event_number: 1 }], "m1", first);
    expect(undo).toBe(4);
    const asOf = snapshotAsOf(M, now, first, undoBefore, undo)!;
    expect(asOf.team_a_point_label).toBe("15");
    expect(asOf.last_event_type).toBe("UNDO");
    expect(asOf.last_undo_event_number).toBe(4);
  });

  it("a finished match inside the window shows the score before the last point", () => {
    let s = initialScoreState("A");
    for (let i = 0; i < 3; i++) s = awardPoint(s, "A", rules);
    const before = s;
    // The stored state after the match point (the engine's own end is tested in scoring/).
    const after: ScoreState = { ...awardPoint(s, "A", rules), matchOver: true, winner: "A" };
    const stored = { ...snapshotRowFromState(M, after, 5, {}, iso(T0 + 1_000)) } as MatchSnapshot;
    const asOf = snapshotAsOf(M, stored, 5, ev(4, "POINT_AWARDED", before, T0 - 100), 0)!;
    expect((asOf.snapshot_json as ScoreState).matchOver).toBe(false);
    expect(asOf.team_a_point_label).toBe("40");
  });
});

describe("ties and advancement as of the cutoff", () => {
  const tie = (o: Partial<Tie>): Tie =>
    ({ id: "t1", tournament_id: "x", stage: "placement", group_id: null, draw_from: null, draw_to: null, places_from: null, places_to: null, round_no: 1, round_name: null, tie_order: 1, court_id: null, scheduled_time: null, team_a_id: "EGY", team_b_id: "ESP", status: "live", rubbers_a: 0, rubbers_b: 0, winner_team_id: null, winner_to_tie_id: null, winner_to_side: null, loser_to_tie_id: null, loser_to_side: null, lineup_locked_at: null, ended_at: null, ...o }) as Tie;
  const rubber = (id: string, o: Partial<Match>) => ({ id, tie_id: "t1", team_a_id: "EGY", team_b_id: "ESP", status: "scheduled", winner_team_id: null, ...o }) as Pick<Match, "id" | "status" | "winner_team_id" | "team_a_id" | "team_b_id" | "tie_id">;

  it("a rubber won inside the window: the tie score and winner go back", () => {
    const real = [rubber("r1", { status: "completed", winner_team_id: "EGY" }), rubber("r2", { status: "completed", winner_team_id: "EGY" }), rubber("r3", { status: "cancelled" })];
    const delayed = [real[0], { ...real[1], status: "live" as const, winner_team_id: null }, real[2]];
    const decided = tie({ status: "completed", rubbers_a: 2, winner_team_id: "EGY", ended_at: iso(T0 + 1_000), winner_to_tie_id: "t2", winner_to_side: "A", loser_to_tie_id: "t3", loser_to_side: "B" });
    const out = tiesAsOf([decided], real, delayed, () => false);
    expect(out.ties[0]).toMatchObject({ rubbers_a: 1, rubbers_b: 0, winner_team_id: null, status: "live", ended_at: null });
    // The dead rubber the result cancelled is back on the order of play.
    expect(out.rubbers.find((r) => r.id === "r3")?.status).toBe("scheduled");

    const next = tie({ id: "t2", status: "scheduled", team_a_id: "EGY", team_b_id: "JPN" });
    const third = tie({ id: "t3", status: "scheduled", team_a_id: "USA", team_b_id: "ESP" });
    const nextRubber = { ...rubber("n1", { tie_id: "t2", team_a_id: "EGY", team_b_id: "JPN" }), team_a_player_ids: ["p1"] };
    const masked = maskTieAdvancement([decided, next, third], [out.ties[0], next, third], [nextRubber]);
    expect(masked.ties.find((t) => t.id === "t2")).toMatchObject({ team_a_id: null, team_b_id: "JPN" });
    expect(masked.ties.find((t) => t.id === "t3")).toMatchObject({ team_a_id: "USA", team_b_id: null });
    expect(masked.rubbers[0]).toMatchObject({ team_a_id: null, team_a_player_ids: [], team_b_id: "JPN" });
  });

  it("a tie nothing changed in is left as it is", () => {
    const real = [rubber("r1", { status: "completed", winner_team_id: "EGY" })];
    const t = tie({ rubbers_a: 1 });
    expect(tiesAsOf([t], real, real, () => true).ties[0]).toBe(t);
  });

  it("a knockout winner inside the window is not in the next round yet", () => {
    const real = [
      { id: "sf1", stage: "semi_final", status: "completed", winner_team_id: "A", team_a_id: "A", team_b_id: "B" },
      { id: "f", stage: "final", status: "scheduled", winner_team_id: null, team_a_id: "A", team_b_id: null },
      { id: "tp", stage: "third_place", status: "scheduled", winner_team_id: null, team_a_id: "B", team_b_id: null },
      { id: "g", stage: "group", status: "scheduled", winner_team_id: null, team_a_id: "A", team_b_id: "C" },
    ] as Pick<Match, "id" | "stage" | "status" | "winner_team_id" | "team_a_id" | "team_b_id">[];
    const delayed = real.map((m) => (m.id === "sf1" ? { ...m, status: "live" as const, winner_team_id: null } : m));
    const out = maskAdvancement(real, delayed);
    expect(out.matches.find((m) => m.id === "f")?.team_a_id).toBeNull();
    expect(out.matches.find((m) => m.id === "tp")?.team_a_id).toBeNull();
    expect(out.matches.find((m) => m.id === "g")?.team_a_id).toBe("A");
    expect(out.matches.find((m) => m.id === "sf1")?.team_a_id).toBe("A");
    const slots = maskBracketSlots([{ match_id: "f", team_id: "A" }, { match_id: "sf1", team_id: "A" }], out.hidden);
    expect(slots).toEqual([{ match_id: "f", team_id: null }, { match_id: "sf1", team_id: "A" }]);
    // Nothing finished inside the window: nothing hidden.
    expect(maskAdvancement(real, real).matches).toBe(real);
  });
});
