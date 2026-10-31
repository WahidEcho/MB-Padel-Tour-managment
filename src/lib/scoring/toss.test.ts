import { describe, expect, it } from "vitest";
import { awardPoint, endsChange, initialScoreState, type ScoreState, type TeamKey } from "./engine";
import { startMatch } from "./console";
import { endChangesSoFar, leftTeamNow, sidesSwapped } from "./timing";
import { answerToss, beforeFirstPoint, parseToss, tossHeadline, tossQuestion, tossRecord, tossSentence, type TossAnswers } from "./toss";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";

const names = (k: TeamKey) => (k === "A" ? "Egypt" : "Spain");

/** Answers each question in turn with the given values. */
function toss(...values: string[]): TossAnswers {
  let a: TossAnswers = {};
  for (const v of values) {
    const q = tossQuestion(a);
    if (!q) throw new Error("toss already complete");
    a = answerToss(a, q, v as never);
  }
  return a;
}

describe("the toss, question by question (ITF rule 4)", () => {
  it("winner chooses to serve: the opponent takes a side", () => {
    expect(tossQuestion({})).toEqual({ kind: "winner" });
    expect(tossQuestion(toss("A"))).toEqual({ kind: "winnerChoice", team: "A" });
    expect(tossQuestion(toss("A", "serve"))).toEqual({ kind: "side", team: "B" });
    const r = tossRecord(toss("A", "serve", "left"))!;
    expect(r).toMatchObject({ winner: "A", deferred: false, servingTeam: "A", leftTeam: "B" });
    expect(tossSentence(r, names)).toBe("Egypt won the toss and chose to serve; Spain took the left side.");
  });

  it("winner chooses to receive: the opponent serves and takes a side", () => {
    const r = tossRecord(toss("B", "receive", "right"))!;
    expect(r).toMatchObject({ servingTeam: "A", leftTeam: "B" });
    expect(tossSentence(r, names)).toBe("Spain won the toss and chose to receive; Egypt took the right side.");
  });

  it("winner chooses a side: the opponent chooses serve or receive", () => {
    expect(tossQuestion(toss("A", "side"))).toEqual({ kind: "side", team: "A" });
    expect(tossQuestion(toss("A", "side", "right"))).toEqual({ kind: "serveOrReceive", team: "B" });
    const r = tossRecord(toss("A", "side", "right", "receive"))!;
    expect(r).toMatchObject({ servingTeam: "A", leftTeam: "B" });
    expect(tossSentence(r, names)).toBe("Egypt won the toss and chose the right side; Spain chose to receive.");
  });

  it("winner lets the opponent choose: one choice each, the winner gets the remaining one", () => {
    expect(tossQuestion(toss("A", "defer"))).toEqual({ kind: "choice", team: "B" });
    const serve = tossRecord(toss("A", "defer", "serve", "left"))!;
    expect(serve).toMatchObject({ deferred: true, servingTeam: "B", leftTeam: "A", first: { team: "B", choice: "serve" }, second: { team: "A", choice: "side", side: "left" } });
    expect(tossSentence(serve, names)).toBe("Egypt won the toss and let Spain choose. Spain chose to serve; Egypt took the left side.");
    expect(tossHeadline(serve, (k) => (k === "A" ? "EGY" : "ESP"))).toBe("EGY won the toss · ESP chose to serve");
    const side = tossRecord(toss("A", "defer", "side", "left", "serve"))!;
    expect(side).toMatchObject({ servingTeam: "A", leftTeam: "B" });
  });

  it("changing an earlier answer drops the ones after it", () => {
    const a = toss("A", "side", "left");
    expect(answerToss(a, { kind: "winner" }, "B")).toEqual({ winner: "B" });
    expect(answerToss(a, { kind: "winnerChoice", team: "A" }, "serve")).toEqual({ winner: "A", deferred: false, first: "serve" });
    expect(tossRecord(toss("A", "serve"))).toBeNull();
  });

  it("only a well-formed stored toss is read back", () => {
    const r = tossRecord(toss("A", "serve", "left"))!;
    expect(parseToss(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(parseToss({ ...r, winner: "C" })).toBeNull();
    expect(parseToss({ ...r, second: { team: "B", choice: "side" } })).toBeNull();
    expect(parseToss({ ...r, first: { ...r.first, team: "B" } })).toBeNull();
    expect(parseToss(null)).toBeNull();
  });
});

describe("where each team stands", () => {
  it("MATCH_STARTED carries the toss and the starting sides", () => {
    const r = tossRecord(toss("B", "receive", "left"))!;
    const ev = startMatch("B", r);
    expect(ev.payload).toEqual({ first_server: "A", toss: r });
    expect(ev.next.servingTeam).toBe("A");
    expect(ev.next.leftAtStart).toBe("A");
    expect(leftTeamNow(ev.next)).toBe("A");
    expect(beforeFirstPoint(ev.next)).toBe(true);
    // Without a toss: exactly as before.
    expect(startMatch("B")).toMatchObject({ payload: { first_server: "B" }, next: initialScoreState("B") });
    expect(leftTeamNow(startMatch("B").next)).toBeNull();
  });

  it("counts the changes of ends exactly as endsChange calls them, through whole matches", () => {
    const configs = [DEFAULT_TENNIS_SCORING_CONFIG, { ...DEFAULT_TENNIS_SCORING_CONFIG, matchTiebreak: true, matchTiebreakPoints: 10 }];
    let sets = 0;
    let tiebreaks = 0;
    for (const config of configs) {
      for (let seed = 1; seed <= 40; seed++) {
        // A seeded sequence of point winners: long sets, short sets and tie-breaks, every run the same.
        let x = seed * 7919;
        const nextWinner = (): TeamKey => {
          x = (x * 1103515245 + 12345) % 2147483648;
          return x % 100 < 50 + ((seed % 5) - 2) * 6 ? "A" : "B";
        };
        let s: ScoreState = { ...initialScoreState("A"), leftAtStart: "A" };
        let changes = 0;
        for (let i = 0; i < 5000 && !s.matchOver; i++) {
          const next = awardPoint(s, nextWinner(), config);
          if (endsChange(s, next).changeEnds) changes++;
          s = next;
          if (!s.matchOver) {
            expect(endChangesSoFar(s)).toBe(changes);
            expect(sidesSwapped(s, { auto: false, manual: false })).toBe(changes % 2 === 1);
            expect(leftTeamNow(s)).toBe(changes % 2 === 0 ? "A" : "B");
          }
        }
        expect(s.matchOver).toBe(true);
        sets += s.completedSets.length;
        tiebreaks += s.completedSets.filter((c) => c.tiebreak).length;
      }
    }
    // The runs really went through tie-breaks and many sets.
    expect(sets).toBeGreaterThan(100);
    expect(tiebreaks).toBeGreaterThan(5);
  });
});
