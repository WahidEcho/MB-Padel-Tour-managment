import { describe, expect, it } from "vitest";
import { queueableResult, resultPayloadOf, resultRejection } from "./finalResult";
import { DEFAULT_SCORING_CONFIG } from "../types";

const rules = DEFAULT_SCORING_CONFIG;

describe("queueableResult (validated before it is queued)", () => {
  it("queues a result the rules can produce", () => {
    const r = queueableResult({ mode: "either", engine: "games", rules, payload: { sets: [{ a: 6, b: 3 }] } });
    expect(r.ok && r.winner === "A" && r.over).toBe(true);
  });
  it("never queues a bad score, a point-by-point match or an organiser's decision", () => {
    expect(queueableResult({ mode: "either", engine: "games", rules, payload: { sets: [{ a: 7, b: 6 }] } }).ok).toBe(false);
    const mode = queueableResult({ mode: "point_by_point", engine: "games", rules, payload: { sets: [{ a: 6, b: 3 }] } });
    expect(!mode.ok && mode.problems[0].code).toBe("mode");
    const adv = queueableResult({ mode: "final_score", engine: "chess", rules, payload: { chess: ["draw"], advance: "A" }, competition: "knockout" });
    expect(!adv.ok && adv.problems[0].code).toBe("advance_not_allowed");
  });
  it("queues a level chess knockout as not over", () => {
    const r = queueableResult({ mode: "final_score", engine: "chess", rules, payload: { chess: ["draw"] }, competition: "knockout" });
    expect(r.ok && !r.over && r.winner === null).toBe(true);
  });
});

describe("resultRejection (a refused result never blocks the match)", () => {
  const ev = (n: number, type: string, id = `e${n}`) => ({
    client_event_id: id,
    event_number: n,
    event_type: type,
    previous_state: { n: n - 1 },
    payload: type === "RESULT_ENTERED" ? { sets: [{ a: 6, b: 3 }] } : null,
  });
  it("drops the named result and anything queued after it, back to the score before it", () => {
    const pending = [ev(4, "POINT_AWARDED"), ev(5, "RESULT_ENTERED"), ev(6, "MATCH_ENDED")];
    const r = resultRejection(pending, 400, { event: "e5", error: "Set 1: 6-5 cannot finish a set.", problems: [{ code: "set_score", set: 0, message: "x" }] });
    expect(r?.drop.map((e) => e.event_number)).toEqual([5, 6]);
    expect(r?.restore).toEqual({ n: 4 });
    expect(r?.lastEventNumber).toBe(4);
    expect(r?.message).toMatch(/6-5/);
    expect(r?.problems[0].code).toBe("set_score");
    expect(resultPayloadOf(r!.result)).toEqual({ sets: [{ a: 6, b: 3 }] });
  });
  it("a 400 about something else is not about the result", () => {
    expect(resultRejection([ev(5, "RESULT_ENTERED")], 400, { error: "Unknown event type" })).toBeNull();
    expect(resultRejection([ev(5, "POINT_AWARDED")], 409, { conflict: "sequence" })).toBeNull();
    expect(resultRejection([ev(5, "RESULT_ENTERED")], 500, {})).toBeNull();
  });
  it("a conflict (the match moved on, another device) sends a queued result back for re-entry", () => {
    const r = resultRejection([ev(5, "RESULT_ENTERED")], 409, { error: "Event sequence mismatch", conflict: "sequence" });
    expect(r?.drop.map((e) => e.client_event_id)).toEqual(["e5"]);
  });
});
