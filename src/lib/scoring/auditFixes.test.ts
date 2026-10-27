/**
 * Scoring audit fixes, without a database:
 * - M2: a v2 event must start from the server's own score (v2ChainCut);
 * - L4: a court referee code changes a finished match only within the carry-over grace (finishedLockCut);
 * - L5: the serve order: set at a set start from the server's own score (any team), and none in singles;
 * - L9: a step that moves the score closes a running timer, and Undo never brings one back.
 */
import { describe, expect, it } from "vitest";
import * as C from "./console";
import { awardGame, awardPoint, initialScoreState, manualEndSet, type ScoreState } from "./engine";
import { expectedV2State, finishedLockCut, isCourtCode, shadowMismatches, v2ChainCut, v2Cut } from "./eventGuard";
import { liveClock, startClock, withoutClock } from "./timing";
import { scoringConfigForMatch } from "./rules";
import { SCORING_FEATURES_ON } from "../matchday/rules";
import { CARRY_GRACE_MINUTES } from "../orgs/courtScope";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";

const config = scoringConfigForMatch({ sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG }, { stage: "group" });
const doublesConfig = scoringConfigForMatch({ sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG }, { stage: "group" }, null, { doubles: true });
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

function play(build: ((cur: ScoreState) => C.ConsoleEvent | null)[], start: ScoreState, first = 1): Ev[] {
  let cur = start;
  const out: Ev[] = [];
  let n = first;
  for (const b of build) {
    const e = b(cur);
    if (!e) throw new Error("console refused");
    out.push({ event_number: n++, event_type: e.eventType, team_id: e.team ? TEAM[e.team] : null, payload: e.payload, previous_state: cur, new_state: e.next });
    cur = e.next;
  }
  return out;
}

const game = (s: ScoreState, k: "A" | "B", cfg = config) => {
  for (let i = 0; i < 4; i++) s = awardPoint(s, k, cfg);
  return s;
};

/* ---------------- M2 ---------------- */

describe("M2: a v2 event starts from the server's score", () => {
  const stored = awardPoint(initialScoreState("A"), "A", config); // 15-0, the server's snapshot

  it("an honest batch chains: the first from the stored score, each later one from the event before it", () => {
    const evs = play([(s) => C.faultEvent(s, o), (s) => C.point(s, "B", o), (s) => C.aceEvent(s, o), (s) => C.letEvent(s, "point")], stored, 3);
    expect(v2ChainCut(evs, stored)).toBeNull();
  });

  it("a v2 event whose previous_state is not the stored score is refused, even though its new_state follows from it", () => {
    // The device claims 40-0 and sends the ace the engine gives from there: v2Cut alone accepts it.
    const forged = { ...stored, teamA: { ...stored.teamA, points: "40" as const } };
    const evs = play([(s) => C.aceEvent(s, o)], forged, 3);
    expect(v2Cut(evs, { teamA: TEAM.A, config, features: SCORING_FEATURES_ON })).toBeNull();
    const cut = v2ChainCut(evs, stored);
    expect(cut?.index).toBe(0);
    expect(cut?.code).toBe("stale_state");
  });

  it("a break in the chain inside a batch is refused at that event; the events before it stand", () => {
    const first = play([(s) => C.letEvent(s, "point")], stored, 3);
    const elsewhere = { ...stored, teamB: { ...stored.teamB, games: 4 } };
    const second = play([(s) => C.aceEvent(s, o)], elsewhere, 4);
    const cut = v2ChainCut([...first, ...second], stored);
    expect(cut?.index).toBe(1);
  });

  it("only v2 events are held to it: 1.0.1's plain points chain however their states were built", () => {
    const old = play([(s) => C.point(s, "A", o)], { ...stored, teamA: { ...stored.teamA, games: 3 } }, 3);
    expect(v2ChainCut(old, stored)).toBeNull();
    // ...but a v2 event after them must follow on from what they left.
    const v2 = play([(s) => C.aceEvent(s, o)], old[0].new_state, 4);
    expect(v2ChainCut([...old, ...v2], stored)).toBeNull();
    const stale = play([(s) => C.aceEvent(s, o)], stored, 4);
    expect(v2ChainCut([...old, ...stale], stored)?.index).toBe(1);
  });

  it("the comparison survives jsonb (key order, absent vs undefined)", () => {
    const viaJsonb = JSON.parse(JSON.stringify(stored)) as ScoreState;
    const reordered = Object.fromEntries(Object.entries(viaJsonb).reverse()) as unknown as ScoreState;
    const evs = play([(s) => C.faultEvent(s, o)], stored, 3);
    expect(v2ChainCut(evs, reordered)).toBeNull();
  });
});

/* ---------------- L4 ---------------- */

describe("L4: court codes and finished matches", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const endedAgo = (min: number) => new Date(now - min * 60_000).toISOString();
  const undo = [{ event_number: 90, event_type: "UNDO" }];
  const court = { scopeCourt: { name: "Court 1" }, referee: { role: "referee" } };

  it("who is a court code: a court referee code or its carry-over token, never a master, a whole-event code or a member", () => {
    expect(isCourtCode(court)).toBe(true);
    expect(isCourtCode({ scopeMatchIds: ["m1"] })).toBe(true);
    expect(isCourtCode({ scopeCourt: { name: "Court 1" }, referee: { role: "master_referee" } })).toBe(false);
    expect(isCourtCode({ scopeTournamentIds: ["t1"] })).toBe(false);
    expect(isCourtCode({ scopeCourt: null, scopeMatchIds: null })).toBe(false);
    expect(isCourtCode(null)).toBe(false);
  });

  it(`a court code may undo a finished match for ${CARRY_GRACE_MINUTES} minutes after it ended, not after`, () => {
    expect(finishedLockCut(true, { status: "completed", ended_at: endedAgo(5) }, undo, now)).toBeNull();
    expect(finishedLockCut(true, { status: "completed", ended_at: endedAgo(CARRY_GRACE_MINUTES) }, undo, now)).toBeNull();
    const late = finishedLockCut(true, { status: "completed", ended_at: endedAgo(CARRY_GRACE_MINUTES + 1) }, undo, now);
    expect(late?.code).toBe("finished_locked");
    expect(late?.index).toBe(0);
    // A result correction or a walkover after the grace too; a match finished with no end time counts as long over.
    expect(finishedLockCut(true, { status: "retired", ended_at: null }, [{ event_number: 9, event_type: "RESULT_ENTERED" }], now)?.code).toBe("finished_locked");
  });

  it("everyone else, and a match that is not finished, are not limited", () => {
    expect(finishedLockCut(false, { status: "completed", ended_at: endedAgo(600) }, undo, now)).toBeNull();
    expect(finishedLockCut(true, { status: "live", ended_at: null }, undo, now)).toBeNull();
    expect(finishedLockCut(true, { status: "completed", ended_at: endedAgo(600) }, [], now)).toBeNull();
  });
});

/* ---------------- L5 ---------------- */

describe("L5: the serve order", () => {
  const order = { servingTeam: "A" as const, server: 0 as const, receiver: 0 as const, otherServer: 0 as const, otherReceiver: 0 as const };

  it("singles has no serve order: the console builds none and the server refuses one", () => {
    const start = initialScoreState("A");
    expect(C.serveOrderEvent(start, order, false)).toBeNull();
    const sent = C.serveOrderEvent(start, order)!; // a console that sends it anyway
    const ev = { event_type: "SERVE_ORDER", team_id: null, previous_state: start, new_state: sent.next, payload: sent.payload };
    expect(expectedV2State(ev, { teamA: TEAM.A, config, doubles: false }).ok).toBe(false);
    expect(v2Cut([ev], { teamA: TEAM.A, config, features: SCORING_FEATURES_ON, doubles: false })?.code).toBe("state_mismatch");
    expect(v2Cut([ev], { teamA: TEAM.A, config: doublesConfig, features: SCORING_FEATURES_ON, doubles: true })).toBeNull();
  });

  it("after the first set the referee may name the other team; the server still rebuilds the state", () => {
    let s = C.serveOrderEvent(initialScoreState("A"), order, true)!.next;
    for (let i = 0; i < 6; i++) s = game(s, "A", doublesConfig); // 6-0: A serves set 2's first game by the rotation
    expect(s.currentSet).toBe(2);
    // Owner, 27 Oct 2026: the console asks the country at every set; a correction is the referee's call.
    const changed = C.serveOrderEvent(s, { ...order, servingTeam: "B" }, true)!;
    expect(changed.next.servingTeam).toBe("B");
    const ev = { event_type: "SERVE_ORDER", team_id: null, previous_state: s, new_state: changed.next, payload: changed.payload };
    expect(v2Cut([ev], { teamA: TEAM.A, config: doublesConfig, features: SCORING_FEATURES_ON, doubles: true })).toBeNull();
    // A state the order does not give (here: only the team flipped, no order recorded) is still refused.
    const forged = { ...ev, new_state: { ...s, servingTeam: "B" as const } };
    expect(v2Cut([forged], { teamA: TEAM.A, config: doublesConfig, features: SCORING_FEATURES_ON, doubles: true })?.code).toBe("state_mismatch");
  });

  it("the first set's toss may name either team", () => {
    const e = C.serveOrderEvent(initialScoreState("A"), { ...order, servingTeam: "B" }, true)!;
    expect(e.next.servingTeam).toBe("B");
    const ev = { event_type: "SERVE_ORDER", team_id: null, previous_state: initialScoreState("A"), new_state: e.next, payload: e.payload };
    expect(v2Cut([ev], { teamA: TEAM.A, config: doublesConfig, features: SCORING_FEATURES_ON, doubles: true })).toBeNull();
  });
});

/* ---------------- L9 ---------------- */

describe("L9: timers close when play goes on, and Undo never resurrects one", () => {
  const at = "2026-10-20T12:00:00.000Z";
  const now = Date.parse(at) + 40_000;
  // 2-1 in games: a changeover is running.
  let base = initialScoreState("A");
  base = game(game(game(base, "A"), "B"), "A");
  const running = startClock(base, "changeover", at);

  it("the running changeover shows on the TV before play goes on", () => {
    expect(liveClock(running, now)?.kind).toBe("changeover");
  });

  it("a point, a game penalty and a set end close it in the state", () => {
    expect(awardPoint(running, "B", config).clock).toBeUndefined();
    expect(awardGame(running, "B", config).clock).toBeUndefined();
    expect(manualEndSet(running, "A", config).clock).toBeUndefined();
    expect(C.violation(running, "A", "racket_abuse", o)?.next.clock).toBeDefined(); // a warning moves nothing: still running
    expect(C.endWith(running, "RETIREMENT", "A", true).next.clock).toBeUndefined();
  });

  it("the undo stack and Undo carry no running timer, so the TV shows none after an Undo", () => {
    // The referee scored without stopping the changeover (an older console, or a step that does not stop it).
    const p = C.point(running, "B", o);
    const history = C.nextHistory([], running, p.eventType);
    expect(history[0].clock).toBeUndefined();
    // A history built before (a stored previous state with the clock in it) is no different.
    const u = C.undo([running], false)!;
    expect(u.next.clock).toBeUndefined();
    expect(liveClock(u.next, now)).toBeNull();
    expect(u.next.teamA.games).toBe(2);
  });

  it("a timer started, a step that keeps the score, the timer stopped, then Undo: the old clock stays stopped", () => {
    // TIMER_STARTED, SERVER_CHANGED (history gets the state with the clock), TIMER_STOPPED, UNDO.
    const sw = C.switchServer(running)!;
    let h = C.nextHistory([], running, sw.eventType);
    const stop = C.timerStop(sw.next, "changeover", 30);
    h = C.nextHistory(h, sw.next, stop.eventType);
    const u = C.undo(h, false)!;
    expect(liveClock(u.next, now)).toBeNull();
  });

  it("states without a clock are left as they are (1.0.1's sequences give identical states)", () => {
    const s = awardPoint(initialScoreState("A"), "A", config);
    expect(withoutClock(s)).toBe(s);
    expect(C.undo([s], false)!.next).toBe(s);
  });

  it("the server's checks do not count a clock against a point: an ace from a state with one is accepted", () => {
    // A console built before points dropped the clock sends the ace with the clock still in it.
    const stale = { ...awardPoint(running, "A", config), clock: running.clock };
    const ace = C.aceEvent(running, o)!; // B serves game 4
    expect(ace.next.clock).toBeUndefined();
    const withClock = { ...ace.next, clock: running.clock };
    const ev = { event_number: 30, event_type: "POINT_AWARDED", team_id: TEAM[ace.team!], payload: ace.payload, previous_state: running, new_state: withClock };
    expect(v2Cut([ev], { teamA: TEAM.A, config, features: SCORING_FEATURES_ON })).toBeNull();
    // Move Score 1.0.1's plain point copies the clock along: not a shadow mismatch either.
    const old = { event_number: 30, event_type: "POINT_AWARDED", team_id: TEAM.A, payload: null, previous_state: running, new_state: stale };
    expect(shadowMismatches([old], { snapshotState: running, teamA: TEAM.A, config })).toEqual([]);
  });
});
