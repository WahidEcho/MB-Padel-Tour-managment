import { describe, expect, it } from "vitest";
import type { MMatch, MMyPlayer } from "@core";
import { isMine, playsIn } from "./mine";

const match = (over: Partial<MMatch>): MMatch => ({
  id: "m1",
  tieId: null,
  rubberNo: null,
  rubberType: null,
  stage: "group",
  groupId: null,
  round: null,
  order: 1,
  courtId: null,
  scheduledTime: null,
  status: "scheduled",
  a: "teamA",
  b: "teamB",
  aPlayers: [],
  bPlayers: [],
  winner: null,
  startedAt: null,
  endedAt: null,
  score: null,
  ...over,
});

const entry = (playerId: string, teamId: string) => ({ playerId, teamId }) as MMyPlayer["entries"][number];
const me: Pick<MMyPlayer, "playerId" | "entries"> = { playerId: "p1", entries: [entry("p1", "teamA"), entry("p9", "teamX")] };

describe("Mine on the Matches tab", () => {
  it("is every match of the player's team outside a tie", () => {
    expect(playsIn(match({}), me)).toBe(true);
    expect(playsIn(match({ a: "teamC", b: "teamA" }), me)).toBe(true);
    expect(playsIn(match({ a: "teamC", b: "teamD" }), me)).toBe(false);
  });
  it("counts the same person's other entries (another tournament)", () => {
    expect(playsIn(match({ a: "teamX", b: "teamD" }), me)).toBe(true);
  });
  it("in a tie, is only the rubbers the player was nominated for", () => {
    expect(playsIn(match({ tieId: "t1", aPlayers: ["p1"], bPlayers: ["q1"] }), me)).toBe(true);
    expect(playsIn(match({ tieId: "t1", aPlayers: ["p2"], bPlayers: ["q1"] }), me)).toBe(false);
    // Line-up not in yet: the team's rubbers count, as on the server.
    expect(playsIn(match({ tieId: "t1" }), me)).toBe(true);
  });
  it("is nobody's without a linked player, but starred matches are always mine", () => {
    expect(playsIn(match({}), null)).toBe(false);
    expect(isMine(match({ a: "teamC", b: "teamD" }), null, ["m1"])).toBe(true);
    expect(isMine(match({ a: "teamC", b: "teamD" }), me, [])).toBe(false);
  });
});
