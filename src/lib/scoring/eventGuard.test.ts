import { describe, expect, it } from "vitest";
import { batchProblem, sameState, shadowMismatches, MAX_EVENTS_PER_BATCH } from "./eventGuard";
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
