import { describe, expect, it } from "vitest";
import { batchProblem, chessDecisionCut, correctionCut, endsMatch, finishedMatchCut, reopensMatch, sameState, shadowMismatches, undoAfterResultCut, MAX_EVENTS_PER_BATCH } from "./eventGuard";
import { awardPoint, initialScoreState } from "./engine";
import { DEFAULT_SCORING_CONFIG } from "../types";

const match = { team_a_id: "team-a-000000000000", team_b_id: "team-b-000000000000" };
const ev = (over: Partial<Parameters<typeof batchProblem>[0][number]> = {}) => ({
  client_event_id: "0d9c5c1e-1111-4111-8111-111111111111",
  event_number: 1,
  event_type: "POINT_AWARDED",
  team_id: match.team_a_id,
  payload: null,
  new_state: {},
  ...over,
});

describe("batchProblem", () => {
  it("accepts a normal batch", () => {
    expect(batchProblem([ev()], match)).toBeNull();
  });
  it("refuses unknown event types", () => {
    expect(batchProblem([ev({ event_type: "DROP_TABLE" })], match)?.error).toMatch(/Unknown event type/);
  });
  it("refuses a team that is not in the match", () => {
    expect(batchProblem([ev({ team_id: "someone-else" })], match)?.error).toMatch(/team_id/);
  });
  it("refuses a winner that is not in the match", () => {
    expect(batchProblem([ev({ event_type: "WALKOVER", payload: { winner_team_id: "x" } })], match)?.error).toMatch(/winner_team_id/);
  });
  it("refuses duplicate ids and oversized batches", () => {
    expect(batchProblem([ev(), ev({ event_number: 2 })], match)?.error).toMatch(/Duplicate/);
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => ev({ client_event_id: `id-${String(i).padStart(10, "0")}`, event_number: i + 1 }));
    expect(batchProblem(many, match)?.error).toMatch(/At most/);
  });
  it("refuses a missing state", () => {
    expect(batchProblem([ev({ new_state: null })], match)?.error).toMatch(/new_state/);
  });
});

describe("sameState", () => {
  it("ignores key order and undefined keys", () => {
    expect(sameState({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1, d: undefined })).toBe(true);
    expect(sameState({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameState([1, 2], [2, 1])).toBe(false);
  });
});

describe("shadowMismatches", () => {
  const config = { ...DEFAULT_SCORING_CONFIG };
  const s0 = initialScoreState("A");
  const s1 = awardPoint(s0, "A", config);
  const s2 = awardPoint(s1, "B", config);
  it("finds nothing when the client used the engine", () => {
    const out = shadowMismatches(
      [
        { event_number: 2, event_type: "POINT_AWARDED", team_id: match.team_a_id, previous_state: s0, new_state: s1 },
        { event_number: 3, event_type: "POINT_AWARDED", team_id: match.team_b_id, previous_state: s1, new_state: s2 },
      ],
      { snapshotState: JSON.parse(JSON.stringify(s0)), teamA: match.team_a_id, config },
    );
    expect(out).toEqual([]);
  });
  it("reports a point the engine would not give and a broken chain", () => {
    const out = shadowMismatches(
      [
        { event_number: 2, event_type: "POINT_AWARDED", team_id: match.team_b_id, previous_state: s0, new_state: s1 },
        { event_number: 3, event_type: "POINT_AWARDED", team_id: match.team_b_id, previous_state: s0, new_state: awardPoint(s0, "B", config) },
      ],
      { snapshotState: s0, teamA: match.team_a_id, config },
    );
    expect(out.map((m) => `${m.event_number}:${m.kind}`)).toEqual(["2:point", "3:chain"]);
  });
});

describe("finishedMatchCut", () => {
  const live = { matchOver: false, winner: null };
  const won = { matchOver: true, winner: "A" };
  const e = (n: number, type: string, state: unknown) => ({ event_number: n, event_type: type, new_state: state });

  it("lets a live match play on and finish", () => {
    expect(finishedMatchCut("live", [e(5, "POINT_AWARDED", live), e(6, "POINT_AWARDED", won)], false)).toBeNull();
  });
  it("refuses a second MATCH_ENDED on a completed match", () => {
    const cut = finishedMatchCut("completed", [e(9, "MATCH_ENDED", won)], true);
    expect(cut?.index).toBe(0);
    expect(cut?.error).toMatch(/already finished/);
  });
  it("refuses a WALKOVER or a point after completion", () => {
    expect(finishedMatchCut("completed", [e(9, "WALKOVER", { ...won, winner: "B" })], false)?.index).toBe(0);
    expect(finishedMatchCut("retired", [e(9, "POINT_AWARDED", live)], false)?.index).toBe(0);
  });
  it("accepts an UNDO that reopens the match, and play after it", () => {
    expect(finishedMatchCut("completed", [e(9, "UNDO", live), e(10, "POINT_AWARDED", live)], false)).toBeNull();
  });
  it("refuses an UNDO that leaves the match over when nothing needs confirming", () => {
    expect(finishedMatchCut("completed", [e(9, "UNDO", won)], false)?.index).toBe(0);
  });
  it("treats undoing a confirmation as a reopen when results need confirming", () => {
    expect(finishedMatchCut("completed", [e(9, "UNDO", won), e(10, "MATCH_ENDED", won)], true)).toBeNull();
  });
  it("cuts a batch after the event that finished the match, keeping what came before", () => {
    const batch = [e(5, "POINT_AWARDED", live), e(6, "MATCH_ENDED", won), e(7, "MATCH_ENDED", won)];
    expect(finishedMatchCut("live", batch, true)?.index).toBe(2);
    expect(finishedMatchCut("live", [e(5, "POINT_AWARDED", won), e(6, "WALKOVER", won)], false)?.index).toBe(1);
  });
  it("does not end a match on its last point when results need confirming", () => {
    expect(endsMatch(e(5, "POINT_AWARDED", won), true)).toBe(false);
    expect(endsMatch(e(5, "POINT_AWARDED", won), false)).toBe(true);
    expect(endsMatch(e(5, "RETIREMENT", live), true)).toBe(true);
    expect(reopensMatch(e(5, "POINT_AWARDED", live), true)).toBe(false);
  });
  it("a final result ends the match even when results need confirming (it was confirmed on entry)", () => {
    expect(endsMatch(e(5, "RESULT_ENTERED", won), true)).toBe(true);
    // A level chess knockout is recorded but stays open for the organiser.
    expect(endsMatch(e(5, "RESULT_ENTERED", { matchOver: false, winner: null }), false)).toBe(false);
    expect(finishedMatchCut("live", [e(5, "RESULT_ENTERED", won), e(6, "POINT_AWARDED", live)], true)?.index).toBe(1);
  });
  it("a final result may correct a finished match; nothing else may follow it", () => {
    expect(finishedMatchCut("completed", [e(9, "RESULT_ENTERED", won)], false)).toBeNull();
    expect(finishedMatchCut("walkover", [e(9, "RESULT_ENTERED", { ...won, winner: "B" })], true)).toBeNull();
    expect(finishedMatchCut("completed", [e(9, "RESULT_ENTERED", won), e(10, "MATCH_ENDED", won)], false)?.index).toBe(1);
  });
  it("accepts RESULT_ENTERED as an event type", () => {
    expect(batchProblem([{ ...ev(), event_type: "RESULT_ENTERED", payload: { sets: [{ a: 6, b: 4 }] } }], match)).toBeNull();
  });
});

describe("undoAfterResultCut", () => {
  const ev = (n: number, event_type: string) => ({ event_number: n, event_type });
  it("refuses an UNDO once a result is stored: corrections go through a new result", () => {
    const cut = undoAfterResultCut(true, [ev(4, "UNDO")]);
    expect(cut?.index).toBe(0);
    expect(cut?.error).toMatch(/enter the corrected result/);
  });
  it("refuses an UNDO after a result in the same batch, keeping what came before", () => {
    expect(undoAfterResultCut(false, [ev(3, "UNDO"), ev(4, "RESULT_ENTERED"), ev(5, "UNDO")])?.index).toBe(2);
  });
  it("lets an UNDO through when no result was entered, and a new result after a result", () => {
    expect(undoAfterResultCut(false, [ev(1, "MATCH_STARTED"), ev(2, "POINT_AWARDED"), ev(3, "UNDO")])).toBeNull();
    expect(undoAfterResultCut(true, [ev(6, "RESULT_ENTERED")])).toBeNull();
  });
});

describe("M1: a result over a recorded score is the organiser's (correctionCut)", () => {
  const e = (n: number, t: string) => ({ event_number: n, event_type: t });
  it("a referee enters a first result on a match with no score yet (started, paused, serve chosen)", () => {
    expect(correctionCut("referee", false, [e(1, "RESULT_ENTERED")])).toBeNull();
    expect(correctionCut("referee", false, [e(1, "MATCH_STARTED"), e(2, "SERVER_CHANGED"), e(3, "RESULT_ENTERED")])).toBeNull();
  });
  it("a referee may not replace a score: a finished match, stored points, or points earlier in the batch", () => {
    expect(correctionCut("referee", true, [e(9, "RESULT_ENTERED")])?.index).toBe(0);
    expect(correctionCut("referee", false, [e(1, "MATCH_STARTED"), e(2, "POINT_AWARDED"), e(3, "RESULT_ENTERED")])?.index).toBe(2);
    expect(correctionCut("referee", false, [e(1, "RESULT_ENTERED"), e(2, "RESULT_ENTERED")])?.index).toBe(1);
    expect(correctionCut("referee", false, [e(4, "MOVE_MADE"), e(5, "RESULT_ENTERED")])?.index).toBe(1);
  });
  it("an admin or manager corrects", () => {
    expect(correctionCut("admin", true, [e(9, "RESULT_ENTERED")])).toBeNull();
    expect(correctionCut("manager", true, [e(9, "RESULT_ENTERED")])).toBeNull();
  });
});

describe("M1 (chess): who advances from a level pairing is the organiser's (chessDecisionCut)", () => {
  const level = (winner: string | null) => ({
    legs: 1,
    games: [{ result: "draw" }],
    scoreA: 0.5,
    scoreB: 0.5,
    needsArbiter: winner === null,
    winner,
    matchOver: winner !== null,
  });
  const e = (t: string, state: unknown, payload: Record<string, unknown> | null = null) => ({ event_number: 7, event_type: t, new_state: state, payload });
  it("a referee's MATCH_ENDED naming a winner of a level pairing is refused, in the state or the payload", () => {
    expect(chessDecisionCut("referee", [e("MATCH_ENDED", level("A"))])?.index).toBe(0);
    expect(chessDecisionCut("referee", [e("FORCE_END", level(null), { winner_team_id: "t-b" })])?.index).toBe(0);
  });
  it("the organiser decides; a decisive result and a walkover before any game stay the referee's", () => {
    expect(chessDecisionCut("admin", [e("MATCH_ENDED", level("A"))])).toBeNull();
    expect(chessDecisionCut("referee", [e("MOVE_MADE", { legs: 1, games: [{ result: "white" }], scoreA: 1, scoreB: 0, winner: "A", matchOver: true })])).toBeNull();
    expect(chessDecisionCut("referee", [e("WALKOVER", { legs: 1, games: [{ result: null }], scoreA: 0, scoreB: 0, winner: null }, { winner_team_id: "t-a" })])).toBeNull();
    expect(chessDecisionCut("referee", [e("DRAW_DECLARED", level(null))])).toBeNull();
  });
});
