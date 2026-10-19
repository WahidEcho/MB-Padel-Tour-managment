/**
 * Scoring v2 engine rules: faults, double faults, aces, both lets, and the doubles
 * serve and receive order across sets and tie-breaks (ITF Rules of Tennis 2026,
 * Rules 14 and 5/13 on order of service and receiving).
 */
import { describe, expect, it } from "vitest";
import { awardPoint, currentServer, initialScoreState, servingPlayer, type ScoreState, type TeamKey } from "./engine";
import { ace, aceMoment, applyLet, defaultServeOrder, fault, needsServeOrder, receivingPlayer, scoreKey, serveCourt, serveNumber, setServeOrder } from "./serve";
import { applyViolation, nextPenalty } from "./conduct";
import { scoringConfigForMatch } from "./rules";
import { DEFAULT_TENNIS_SCORING_CONFIG, type ScoringConfig } from "../types";

const tennis = { sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG };
const singles = scoringConfigForMatch(tennis, { stage: "group" });
const doubles = scoringConfigForMatch(tennis, { stage: "group" }, null, { doubles: true });

function pts(s: ScoreState, team: TeamKey, n: number, cfg: ScoringConfig = singles): ScoreState {
  for (let i = 0; i < n; i++) s = awardPoint(s, team, cfg);
  return s;
}
const game = (s: ScoreState, team: TeamKey, cfg: ScoringConfig = singles) => pts(s, team, 4, cfg);

describe("faults and double faults", () => {
  it("a first fault leaves the score and goes to the second serve", () => {
    const s = initialScoreState("A");
    const r = fault(s, singles)!;
    expect(r.doubleFault).toBe(false);
    expect(r.server).toBe("A");
    expect(serveNumber(s)).toBe(1);
    expect(serveNumber(r.next)).toBe(2);
    expect(r.next.teamA.points).toBe("0");
    expect(r.next.teamB.points).toBe("0");
    expect(s.serve).toBeUndefined(); // the input is not touched
  });

  it("a second fault is a double fault: the point goes to the receiver and is counted", () => {
    const s = fault(initialScoreState("A"), singles)!.next;
    const r = fault(s, singles)!;
    expect(r.doubleFault).toBe(true);
    expect(r.next.teamB.points).toBe("15");
    expect(r.next.stats?.doubleFaults).toEqual({ A: 1, B: 0 });
    expect(serveNumber(r.next)).toBe(1);
  });

  it("the referee may press the point straight after a fault: the next point starts on a first serve", () => {
    const s = fault(initialScoreState("A"), singles)!.next;
    const after = awardPoint(s, "A", singles);
    expect(serveNumber(after)).toBe(1);
    expect(after.serve).toBeUndefined();
  });

  it("a second serve left behind by a console that does not know faults is stale once the score moves", () => {
    const s = fault(initialScoreState("A"), singles)!.next;
    // Move Score 1.0.1's engine copies the field along; the score changed, so it no longer counts.
    const old = { ...pts(initialScoreState("A"), "B", 1), serve: s.serve };
    expect(serveNumber(old)).toBe(1);
  });

  it("a double fault can win the game, the set and the match for the receiver", () => {
    let s = initialScoreState("A");
    s = pts(s, "B", 3); // 0-40
    s = fault(fault(s, singles)!.next, singles)!.next;
    expect(s.teamB.games).toBe(1);
    expect(s.servingTeam).toBe("B");
  });

  it("in a tie-break the fault belongs to whoever serves that point", () => {
    let s = initialScoreState("A");
    for (let i = 0; i < 6; i++) s = game(game(s, "A"), "B");
    expect(s.isTiebreak).toBe(true);
    const first = currentServer(s)!;
    const r = fault(fault(s, singles)!.next, singles)!;
    expect(r.server).toBe(first);
    expect(r.doubleFault).toBe(true);
    expect(first === "A" ? r.next.teamB.tiebreakPoints : r.next.teamA.tiebreakPoints).toBe(1);
  });

  it("nothing to fault once the match is over", () => {
    const s = { ...initialScoreState("A"), matchOver: true, winner: "A" as TeamKey };
    expect(fault(s, singles)).toBeNull();
    expect(ace(s, singles)).toBeNull();
  });
});

describe("aces", () => {
  it("an ace is a point to the server, counted, with an ACE moment until the score moves", () => {
    const s = initialScoreState("B");
    const r = ace(s, singles)!;
    expect(r.server).toBe("B");
    expect(r.next.teamB.points).toBe("15");
    expect(r.next.stats?.aces).toEqual({ A: 0, B: 1 });
    expect(aceMoment(r.next)).toBe(true);
    const later = awardPoint(r.next, "A", singles);
    expect(aceMoment(later)).toBe(false);
    expect(later.stats?.aces.B).toBe(1);
  });

  it("an ace on a second serve clears the fault", () => {
    const s = fault(initialScoreState("A"), singles)!.next;
    const r = ace(s, singles)!;
    expect(serveNumber(r.next)).toBe(1);
    expect(r.next.teamA.points).toBe("15");
  });
});

describe("lets", () => {
  it("a serve let keeps a second serve a second serve", () => {
    const s = fault(initialScoreState("A"), singles)!.next;
    const l = applyLet(s, "serve");
    expect(serveNumber(l)).toBe(2);
    expect(scoreKey(l)).toBe(scoreKey(s));
  });

  it("a replayed point starts again from the first serve", () => {
    const s = fault(initialScoreState("A"), singles)!.next;
    const l = applyLet(s, "point");
    expect(serveNumber(l)).toBe(1);
    expect(scoreKey(l)).toBe(scoreKey(s));
  });

  it("neither let changes the score", () => {
    const s = pts(initialScoreState("A"), "A", 2);
    expect(applyLet(s, "serve").teamA.points).toBe("30");
    expect(applyLet(s, "point").teamA.points).toBe("30");
  });
});

describe("time violations: a server's second one costs a serve", () => {
  it("first serve → second serve; second serve → double fault", () => {
    let s = initialScoreState("A");
    s = applyViolation(s, { team: "A", offence: "time", penalty: nextPenalty(s, "A", "time", true) }, singles);
    expect(s.violations?.[0].penalty).toBe("warning");
    const pen = nextPenalty(s, "A", "time", true);
    expect(pen).toBe("fault");
    s = applyViolation(s, { team: "A", offence: "time", penalty: pen }, singles);
    expect(serveNumber(s)).toBe(2);
    s = applyViolation(s, { team: "A", offence: "time", penalty: "fault" }, singles);
    expect(s.teamB.points).toBe("15");
  });
});

describe("doubles: serve and receive order", () => {
  const order = { servingTeam: "A" as TeamKey, server: 1 as const, receiver: 0 as const, otherServer: 1 as const, otherReceiver: 0 as const };

  it("asks at the start of every set, once", () => {
    let s = initialScoreState("A");
    expect(needsServeOrder(s, true)).toBe(true);
    expect(needsServeOrder(s, false)).toBe(false);
    s = setServeOrder(s, order)!;
    expect(needsServeOrder(s, true)).toBe(false);
    for (let i = 0; i < 6; i++) s = game(s, i % 2 === 0 ? "A" : "A", doubles);
    expect(s.currentSet).toBe(2);
    expect(needsServeOrder(s, true)).toBe(true);
  });

  it("refuses an order in the middle of a set", () => {
    const s = pts(initialScoreState("A"), "A", 1, doubles);
    expect(setServeOrder(s, order)).toBeNull();
  });

  it("follows the rotation A2, B2, A1, B1 and the receivers' sides through the set", () => {
    let s = setServeOrder(initialScoreState("B"), order)!;
    expect(s.servingTeam).toBe("A");
    // Game 1: A's player 1 serves; B's player 0 receives in the deuce court, player 1 in the ad court.
    expect(servingPlayer(s)).toEqual({ team: "A", index: 1 });
    expect(receivingPlayer(s)).toEqual({ team: "B", index: 0, court: "deuce" });
    s = pts(s, "A", 1, doubles);
    expect(receivingPlayer(s)).toEqual({ team: "B", index: 1, court: "ad" });
    s = pts(s, "A", 3, doubles); // game A
    // Game 2: B's player 1 serves (Rule 14: the other team chose); A's player 0 receives first.
    expect(servingPlayer(s)).toEqual({ team: "B", index: 1 });
    expect(receivingPlayer(s)).toEqual({ team: "A", index: 0, court: "deuce" });
    s = game(s, "B", doubles);
    // Game 3: A's other player; game 4: B's other player.
    expect(servingPlayer(s)).toEqual({ team: "A", index: 0 });
    s = game(s, "A", doubles);
    expect(servingPlayer(s)).toEqual({ team: "B", index: 0 });
    s = game(s, "B", doubles);
    expect(servingPlayer(s)).toEqual({ team: "A", index: 1 });
  });

  it("deuce goes back to the deuce court; advantage is the ad court", () => {
    let s = setServeOrder(initialScoreState("A"), order)!;
    s = pts(pts(s, "A", 3, singles), "B", 3, singles); // 40-40
    expect(serveCourt(s)).toBe("deuce");
    s = awardPoint(s, "A", singles); // AD
    expect(serveCourt(s)).toBe("ad");
    s = awardPoint(s, "B", singles); // deuce
    expect(serveCourt(s)).toBe("deuce");
  });

  it("a tie-break keeps the rotation and the receivers keep their courts", () => {
    let s = setServeOrder(initialScoreState("A"), { ...order, server: 0, otherServer: 0 })!;
    for (let i = 0; i < 6; i++) s = game(game(s, "A", singles), "B", singles);
    expect(s.isTiebreak).toBe(true);
    // Game 13 is A's player 0's turn (games 1, 5, 9, 13).
    expect(servingPlayer(s)).toEqual({ team: "A", index: 0 });
    expect(receivingPlayer(s)).toEqual({ team: "B", index: 0, court: "deuce" });
    s = awardPoint(s, "A", singles);
    // Point 2 and 3: B's player 0 (games 2, 6, 10 were B0's; B1 had 4, 8, 12 → next turn B0).
    expect(servingPlayer(s)).toEqual({ team: "B", index: 0 });
    expect(receivingPlayer(s)).toEqual({ team: "A", index: 1, court: "ad" });
    s = awardPoint(s, "A", singles);
    expect(servingPlayer(s)).toEqual({ team: "B", index: 0 });
    expect(receivingPlayer(s)).toEqual({ team: "A", index: 0, court: "deuce" });
    s = awardPoint(s, "A", singles);
    expect(servingPlayer(s)).toEqual({ team: "A", index: 1 });
  });

  it("a new set takes a new order; the default offered is the rotation as it stands", () => {
    let s = setServeOrder(initialScoreState("A"), order)!;
    for (let i = 0; i < 6; i++) s = game(s, "A", doubles);
    // 6-0: six games, so A (games 1, 3, 5) serves the first game of set 2 again.
    expect(defaultServeOrder(s).servingTeam).toBe("A");
    const next = setServeOrder(s, { servingTeam: "B", server: 0, receiver: 1, otherServer: 0, otherReceiver: 1 })!;
    expect(next.orderSet).toBe(2);
    expect(servingPlayer(next)).toEqual({ team: "B", index: 0 });
    expect(receivingPlayer(next)).toEqual({ team: "A", index: 1, court: "deuce" });
  });

  it("a match tie-break in place of the final set is asked for too, and its first server is set", () => {
    let s = setServeOrder(initialScoreState("A"), order)!;
    for (let i = 0; i < 6; i++) s = game(s, "A", doubles);
    s = setServeOrder(s, { ...order, servingTeam: "B" })!;
    for (let i = 0; i < 6; i++) s = game(s, "B", doubles);
    expect(s.isMatchTiebreak).toBe(true);
    expect(needsServeOrder(s, true)).toBe(true);
    s = setServeOrder(s, { servingTeam: "B", server: 1, receiver: 0, otherServer: 0, otherReceiver: 1 })!;
    expect(currentServer(s)).toBe("B");
    expect(servingPlayer(s)).toEqual({ team: "B", index: 1 });
    expect(receivingPlayer(s)).toEqual({ team: "A", index: 0, court: "deuce" });
    s = awardPoint(s, "B", doubles);
    expect(servingPlayer(s)).toEqual({ team: "A", index: 0 });
    expect(receivingPlayer(s)).toEqual({ team: "B", index: 0, court: "ad" });
  });
});
