import { describe, expect, it } from "vitest";
import { awardPoint, initialScoreState } from "./engine";
import * as C from "./console";
import { DEFAULT_SCORING_CONFIG } from "../types";
import { batchProblem } from "./eventGuard";

const o = { config: { ...DEFAULT_SCORING_CONFIG }, confirmFirst: false, online: true, tennis: true, doubles: false };

function playGame(s: ReturnType<typeof initialScoreState>, w: "A" | "B") {
  for (let i = 0; i < 4; i++) s = awardPoint(s, w, o.config);
  return s;
}

describe("console actions", () => {
  it("starts a match the way the web console does", () => {
    const e = C.startMatch("B");
    expect(e.eventType).toBe("MATCH_STARTED");
    expect(e.payload).toEqual({ first_server: "B" });
    expect(e.newStatus).toBe("live");
  });
  it("records a point with the engine's state", () => {
    const s = initialScoreState("A");
    const e = C.point(s, "A", o);
    expect(e.next).toEqual(awardPoint(s, "A", o.config));
    expect(e.team).toBe("A");
  });
  it("asks before a point that wins a game, but not before an ordinary one", () => {
    let s = initialScoreState("A");
    expect(C.pointNeedsConfirm(s, "A", o)).toBeNull();
    for (let i = 0; i < 3; i++) s = awardPoint(s, "A", o.config);
    expect(C.pointNeedsConfirm(s, "A", o)).toBe("this game");
  });
  it("does not finish a match on the last point when results need confirming", () => {
    // Default rules: one set to six. Five games, then 40-0 in the sixth.
    let s = initialScoreState("A");
    for (let g = 0; g < 5; g++) s = playGame(s, "A");
    for (let i = 0; i < 3; i++) s = awardPoint(s, "A", o.config);
    expect(s.matchOver).toBe(false);
    const confirm = { ...o, confirmFirst: true };
    expect(C.pointNeedsConfirm(s, "A", confirm)).toBeNull();
    expect(C.pointNeedsConfirm(s, "A", o)).toBe("the MATCH");
    const last = C.point(s, "A", confirm);
    expect(last.next.matchOver).toBe(true);
    expect(last.newStatus).toBeUndefined();
    expect(C.point(s, "A", o).newStatus).toBe("completed");
    expect(C.confirmResult(last.next, confirm)?.eventType).toBe("MATCH_ENDED");
  });
  it("ends early keeping the set in progress", () => {
    let s = initialScoreState("A");
    s = playGame(s, "A");
    s = playGame(s, "B");
    const e = C.endWith(s, "RETIREMENT", "B", true);
    expect(e.next.matchOver).toBe(true);
    expect(e.next.completedSets.at(-1)).toEqual({ teamAGames: 1, teamBGames: 1 });
    expect(e.newStatus).toBe("retired");
    expect(C.endWith(s, "WALKOVER", "A", false).newStatus).toBe("pending_sync");
  });
  it("keeps the undo stack like the web console", () => {
    const a = initialScoreState("A");
    const b = awardPoint(a, "A", o.config);
    const h1 = C.nextHistory([], a, "POINT_AWARDED");
    expect(h1).toEqual([a]);
    expect(C.nextHistory(h1, b, "UNDO")).toEqual([]);
    expect(C.undo(h1, false)?.next).toEqual(a);
  });
  it("produces batches the server accepts", () => {
    const s = initialScoreState("A");
    const e = C.point(s, "A", o);
    const problem = batchProblem(
      [{ client_event_id: "11111111-2222-4333-8444-555555555555", event_number: 1, event_type: e.eventType, team_id: "team-a", payload: e.payload, new_state: e.next }],
      { team_a_id: "team-a", team_b_id: "team-b" },
    );
    expect(problem).toBeNull();
  });
});
