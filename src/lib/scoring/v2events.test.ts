/**
 * Scoring v2 events end to end, without a database: the console builds them, the
 * server's check re-derives them (v2Cut), the settings switch them off, the undo
 * stack skips timers, and the match log reads them back.
 */
import { describe, expect, it } from "vitest";
import * as C from "./console";
import { initialScoreState, type ScoreState } from "./engine";
import { LOG_ONLY_EVENTS, batchProblem, isV2Event, pushesHistory, shadowMismatches, v2Cut } from "./eventGuard";
import { buildMatchLog, type LogEventRow } from "./matchLog";
import { serveNumber } from "./serve";
import { scoringConfigForMatch } from "./rules";
import { SCORING_FEATURES_ON, matchDayRules, type ScoringFeatures } from "../matchday/rules";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";

const config = scoringConfigForMatch({ sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG }, { stage: "group" });
const o: C.ConsoleOptions = { config, confirmFirst: false, online: true, tennis: true, doubles: false };
const TEAM = { A: "team-a", B: "team-b" };

interface Ev {
  event_number: number;
  event_type: string;
  team_id: string | null;
  payload: Record<string, unknown> | null;
  previous_state: ScoreState | null;
  new_state: ScoreState;
}

/** Records console events as the clients do: number, team id, previous and new state. */
function play(build: ((cur: ScoreState) => C.ConsoleEvent | null)[], start = initialScoreState("A")): Ev[] {
  let cur = start;
  const out: Ev[] = [];
  let n = 1;
  for (const b of build) {
    const e = b(cur);
    if (!e) throw new Error("console refused");
    out.push({ event_number: n++, event_type: e.eventType, team_id: e.team ? TEAM[e.team] : null, payload: e.payload, previous_state: cur, new_state: e.next });
    cur = e.next;
  }
  return out;
}

const check = (events: Ev[], features: ScoringFeatures = SCORING_FEATURES_ON) => v2Cut(events, { teamA: TEAM.A, config, features });

describe("v2 events from the console", () => {
  it("fault, fault (double fault), ace, both lets: all accepted by the server's check", () => {
    const evs = play([
      (s) => C.faultEvent(s, o),
      (s) => C.letEvent(s, "serve"),
      (s) => C.faultEvent(s, o),
      (s) => C.aceEvent(s, o),
      (s) => C.faultEvent(s, o),
      (s) => C.letEvent(s, "point"),
    ]);
    expect(evs.map((e) => e.event_type)).toEqual(["FAULT", "LET", "POINT_AWARDED", "POINT_AWARDED", "FAULT", "LET"]);
    expect(evs[2].payload).toEqual({ double_fault: true });
    expect(evs[2].team_id).toBe(TEAM.B);
    expect(evs[3].payload).toEqual({ ace: true });
    expect(evs[3].team_id).toBe(TEAM.A);
    expect(evs[1].payload).toEqual({ kind: "serve", serve: 2 });
    expect(serveNumber(evs[5].new_state)).toBe(1);
    expect(check(evs)).toBeNull();
    expect(batchProblem(evs.map((e) => ({ ...e, client_event_id: `id-${e.event_number}-xxxx` })), { team_a_id: TEAM.A, team_b_id: TEAM.B })).toBeNull();
    expect(shadowMismatches(evs, { snapshotState: null, teamA: TEAM.A, config })).toEqual([]);
  });

  it("refuses a state the rules do not give (an ace that scores for the receiver, a doctored double fault)", () => {
    const [e] = play([(s) => C.aceEvent(s, o)]);
    expect(check([{ ...e, team_id: TEAM.B }])?.code).toBe("state_mismatch");
    const [f] = play([(s) => C.faultEvent(s, o)]);
    // A double fault with no fault before it.
    const fake = { ...f, event_type: "POINT_AWARDED", team_id: TEAM.B, payload: { double_fault: true }, new_state: C.point(f.previous_state!, "B", o).next };
    expect(check([fake])?.code).toBe("state_mismatch");
    const doctored = { ...e, new_state: { ...e.new_state, stats: { aces: { A: 5, B: 0 }, doubleFaults: { A: 0, B: 0 } } } };
    expect(check([doctored])?.code).toBe("state_mismatch");
  });

  it("refuses what the organiser switched off, and reports where", () => {
    const evs = play([(s) => C.point(s, "A", o), (s) => C.faultEvent(s, o)]);
    const cut = check(evs, { ...SCORING_FEATURES_ON, fault: false });
    expect(cut).toMatchObject({ index: 1, code: "feature_off" });
    const t = play([(s) => C.timerStart(s, "bathroom", "2026-10-20T10:00:00.000Z", "A")]);
    expect(check(t, { ...SCORING_FEATURES_ON, bathroom: false })?.code).toBe("feature_off");
    // Stopping a timer is always allowed.
    const stop = play([(s) => C.timerStop(s, "bathroom", 40, "A")], t[0].new_state);
    expect(check(stop, { ...SCORING_FEATURES_ON, bathroom: false })).toBeNull();
  });

  it("a plain point is not a v2 event: Move Score 1.0.1's events are never checked this way", () => {
    const evs = play([(s) => C.point(s, "A", o)]);
    expect(isV2Event(evs[0])).toBe(false);
    expect(check(evs, { ...SCORING_FEATURES_ON, fault: false, ace: false })).toBeNull();
  });

  it("the serve order is only accepted at the start of a set", () => {
    const order = { servingTeam: "A" as const, server: 1 as const, receiver: 0 as const, otherServer: 0 as const, otherReceiver: 1 as const };
    const ok = play([(s) => C.serveOrderEvent(s, order)]);
    expect(check(ok)).toBeNull();
    const mid = play([(s) => C.point(s, "A", o)]);
    expect(C.serveOrderEvent(mid[0].new_state, order)).toBeNull();
    const forged = { ...ok[0], event_number: 2, previous_state: mid[0].new_state, new_state: { ...mid[0].new_state, orderSet: 1 } };
    expect(check([forged])?.code).toBe("state_mismatch");
  });

  it("timers and time rulings are log-only: no undo entry, no score change", () => {
    expect([...LOG_ONLY_EVENTS].sort()).toEqual(["TIMER_STARTED", "TIMER_STOPPED", "TIME_DECISION"]);
    expect(pushesHistory("TIMER_STARTED")).toBe(false);
    expect(pushesHistory("FAULT")).toBe(true);
    const s = initialScoreState("A");
    const h = C.nextHistory([s], s, "TIMER_STARTED");
    expect(h).toHaveLength(1);
    const evs = play([
      (x) => C.point(x, "A", o),
      (x) => C.timerStart(x, "changeover", "2026-10-20T10:00:00.000Z"),
      (x) => C.timeDecision(x, "changeover", "warning", 98, "B"),
      (x) => C.timerStop(x, "changeover", 98),
    ]);
    expect(check(evs)).toBeNull();
    expect(evs[3].new_state.clock).toBeUndefined();
    expect(evs[1].new_state.clock?.kind).toBe("changeover");
  });

  it("the point builders say what follows: a changeover after game 3", () => {
    let s = initialScoreState("A");
    let last: C.ConsoleEvent | null = null;
    for (let i = 0; i < 12; i++) {
      last = C.aceEvent(s, o);
      s = last!.next;
    }
    expect(s.teamA.games + s.teamB.games).toBe(3);
    expect(last!.after).toEqual({ changeEnds: true, timer: "changeover" });
  });
});

describe("settings", () => {
  it("a tournament that saved the Match day tab gets every v2 feature on; an unsaved one: on for tennis, off for padel", () => {
    expect(matchDayRules({ configured: true }, { sport: "tennis" }).features).toEqual(SCORING_FEATURES_ON);
    expect(matchDayRules({}, { sport: "tennis" }).features).toEqual(SCORING_FEATURES_ON);
    expect(matchDayRules({}, { sport: "padel" }).features.fault).toBe(false);
    const saved = matchDayRules({ configured: true, features: { fault: false, tvAces: false, junk: true } }, { sport: "tennis" });
    expect(saved.features.fault).toBe(false);
    expect(saved.features.tvAces).toBe(false);
    expect(saved.features.ace).toBe(true);
    expect((saved.features as unknown as Record<string, unknown>).junk).toBeUndefined();
    expect(matchDayRules({ configured: true }, { sport: "chess" }).features.fault).toBe(false);
  });
});

describe("match log", () => {
  it("every event in order with the score after it, faults, aces, lets, timers, rulings and undos", () => {
    const evs = play([
      (s) => C.faultEvent(s, o),
      (s) => C.faultEvent(s, o), // double fault → 0-15
      (s) => C.aceEvent(s, o), // 15-15
      (s) => C.letEvent(s, "point"),
      (s) => C.point(s, "B", o), // 15-30
      (s) => C.timerStart(s, "bathroom", "2026-10-20T10:00:00.000Z", "B"),
      (s) => C.timerStop(s, "bathroom", 125, "B"),
    ]);
    const rows: LogEventRow[] = evs.map((e) => ({ ...e, at: "2026-10-20T10:00:00.000Z", by: "Sara (referee)" }));
    // An undo of the last scoring action (the 15-30 point): the timers in between are skipped.
    rows.push({ event_number: 8, event_type: "UNDO", team_id: null, payload: null, previous_state: evs[6].new_state, new_state: evs[3].new_state, at: null, by: "Sara (referee)" });
    const log = buildMatchLog(rows, { A: { id: TEAM.A, name: "Egypt" }, B: { id: TEAM.B, name: "USA" } });
    expect(log.map((l) => l.tag)).toEqual(["fault", "double_fault", "ace", "let", "point", "timer", "timer", "undo"]);
    expect(log[0].detail).toBe("Egypt · 1st serve fault");
    expect(log[1].detail).toBe("Egypt · double fault, point USA");
    expect(log[1].title).toBe("Set 1 · Game 1 · 0–0 · 0–15");
    expect(log[2].chip).toBe("ACE");
    expect(log[3].detail).toBe("Let · point replayed (1st serve)");
    expect(log[6].detail).toContain("ran 2:05");
    expect(log[4].undone).toBe(true);
    expect(log[5].undone).toBe(false);
    expect(log[7].by).toBe("Sara (referee)");
  });
  it("a medical timeout for one side: 3:00, logged as MEDICAL with who and how long", () => {
    const evs = play([(s) => C.timerStart(s, "medical", "2026-10-22T10:00:00.000Z", "A"), (s) => C.timerStop(s, "medical", 170, "A")]);
    const rows: LogEventRow[] = evs.map((e) => ({ ...e, at: "2026-10-22T10:00:00.000Z", by: "Sara (referee)" }));
    const log = buildMatchLog(rows, { A: { id: TEAM.A, name: "Egypt" }, B: { id: TEAM.B, name: "USA" } });
    expect(log.map((l) => l.chip)).toEqual(["MEDICAL", "MEDICAL"]);
    expect(log[1].detail).toContain("ran 2:50");
  });
});

describe("which timer follows a point", () => {
  const all = { timerBetweenPoints: true, timerChangeover: true, timerSetBreak: true };
  it("records a changeover and a set break, runs the 25 s on the console only", () => {
    expect(C.followingTimer({ changeEnds: true, timer: "changeover" }, all)).toEqual({ kind: "changeover", record: true });
    expect(C.followingTimer({ changeEnds: false, timer: "set_break" }, all)).toEqual({ kind: "set_break", record: true });
    expect(C.followingTimer({ changeEnds: false, timer: "between_points" }, all)).toEqual({ kind: "between_points", record: false });
    expect(C.followingTimer({ changeEnds: false, timer: null }, all)).toBeNull();
  });
  it("falls back to the 25 s when a changeover timer is off; nothing when that is off too", () => {
    expect(C.followingTimer({ changeEnds: true, timer: "changeover" }, { ...all, timerChangeover: false })).toEqual({ kind: "between_points", record: false });
    expect(C.followingTimer({ changeEnds: true, timer: "changeover" }, { timerBetweenPoints: false, timerChangeover: false, timerSetBreak: true })).toBeNull();
  });
  it("a recorded timer must be stopped before play goes on", () => {
    const s = C.timerStart(initialScoreState("A"), "bathroom", "2026-10-20T10:00:00.000Z", "B").next;
    expect(C.runningClock(s)).toEqual({ kind: "bathroom", startedAt: "2026-10-20T10:00:00.000Z", team: "B" });
    expect(C.runningClock(C.timerStop(s, "bathroom", 10).next)).toBeNull();
  });
});

describe("Move Score 1.0.1 after a fault", () => {
  it("its point (old engine: the stale fault copied along) is not a shadow mismatch", () => {
    const f = C.faultEvent(initialScoreState("A"), o)!.next;
    const oldNext = { ...C.point(f, "B", o).next, serve: f.serve };
    const evs = [{ event_number: 2, event_type: "POINT_AWARDED", team_id: TEAM.B, previous_state: f, new_state: oldNext, payload: null }];
    expect(shadowMismatches(evs, { snapshotState: f, teamA: TEAM.A, config })).toEqual([]);
    expect(serveNumber(oldNext)).toBe(1);
  });
});
