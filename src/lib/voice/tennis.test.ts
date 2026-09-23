import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { awardPoint, endsChange, initialScoreState, type ScoreState, type TeamKey } from "../scoring/engine";
import { scoringConfigForMatch } from "../scoring/rules";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";
import { callForTransition, supportedCall, type SideNames } from "./calls";
import type { PackIndex } from "./pack";
import { PHRASES, PREVIOUS_VOICE_PACKS, captionFor, isTennisClip, nationClip } from "./phrases";

const tournament = { sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG };
const singles = scoringConfigForMatch(tournament, { stage: "group" });
const doubles = scoringConfigForMatch(tournament, { stage: "group" }, null, { doubles: true });
const NATIONS: SideNames = { A: nationClip("ROU"), B: nationClip("USA") };
const INFO = { corrects: false, netPoints: 1, sides: NATIONS, tennis: true };

function play(state: ScoreState, points: string, config = doubles): ScoreState {
  let s = state;
  for (const c of points) s = awardPoint(s, c as TeamKey, config);
  return s;
}
const call = (from: ScoreState, team: TeamKey, config = doubles) =>
  callForTransition(from, awardPoint(from, team, config), INFO, config);

describe("tennis calls", () => {
  it("records every nation and tennis call in the inventory", () => {
    expect(PHRASES[nationClip("ROU")]).toBe("Romania.");
    expect(PHRASES[nationClip("usa")]).toBe("United States.");
    for (const id of ["deciding-point", "match-tie-break", "time", "change-ends"]) expect(PHRASES[id]).toBeTruthy();
  });

  it("names the sides by nation", () => {
    const deuce = play(initialScoreState("A"), "AAABBB", singles);
    expect(call(deuce, "A", singles)).toEqual(["advantage", "nation-ROU"]);
    const game = play(initialScoreState("A"), "AAA");
    expect(call(game, "A")).toEqual(["game-named", "nation-ROU", "games-1-0-named", "nation-ROU", "change-ends"]);
    expect(captionFor(["game-named", "nation-ROU", "games-1-0-named", "nation-ROU", "change-ends"])).toBe(
      "Game, Romania. One game to love, Romania. Change of ends.",
    );
  });

  it("calls a deciding point at forty all under no-ad, instead of break point", () => {
    const s = play(initialScoreState("A"), "AAABB");
    expect(call(s, "B")).toEqual(["pts-40-40", "deciding-point"]);
    // Advantage scoring still calls deuce and then break point.
    const adv = play(initialScoreState("A"), "AAABBB", singles);
    expect(call(adv, "B", singles)).toEqual(["advantage", "nation-USA", "break-point"]);
  });

  it("announces a deciding point that is also a set point as both", () => {
    const fiveLove = play(initialScoreState("A"), "AAAA".repeat(5)); // B serves game six
    const s = play(fiveLove, "BBBAA");
    expect(call(s, "A")).toEqual(["pts-40-40", "deciding-point", "set-point"]);
  });

  it("sends the players to the other end after odd games only", () => {
    let s = initialScoreState("A");
    for (let game = 1; game <= 5; game++) {
      const winner: TeamKey = game % 2 ? "A" : "B";
      s = play(s, winner.repeat(3));
      // A point inside the game: no change.
      expect(call(play(s, ""), winner === "A" ? "B" : "A")).not.toContain("change-ends");
      expect(call(s, winner)!.includes("change-ends")).toBe(game % 2 === 1);
      s = play(s, winner);
    }
  });

  it("calls a match tie-break at one set all", () => {
    const setOne = play(initialScoreState("A"), "AAAA".repeat(6));
    const lastGame = play(setOne, "BBBB".repeat(5) + "BBB");
    const c = call(lastGame, "B");
    expect(c).toEqual(["game-and-set-named", "nation-USA", "sets-all-1", "match-tie-break"]);
    // Six games to love: even, so no change of ends at this set break.
    expect(captionFor(c!)).toBe("Game and set, United States. One set all. Match tie-break.");
  });
});

/** A whole doubles rubber, point by point, as the referee would score it. */
function rubber(pattern: string, config = doubles): { states: ScoreState[] } {
  let s = initialScoreState("A");
  const states = [s];
  let i = 0;
  while (!s.matchOver) {
    s = awardPoint(s, pattern[i++ % pattern.length] as TeamKey, config);
    states.push(s);
    if (i > 5000) throw new Error("runaway");
  }
  return { states };
}

describe("gate: a full doubles rubber called end to end", () => {
  // Sides trade games, so the rubber goes 7-6 6-7 into a match tie-break, with
  // deuces on the way: every tennis call comes up.
  const set = (w: TeamKey, l: TeamKey) => `${w}${w}${w}${l}${l}${l}${w}`;
  const pattern =
    [set("A", "B"), set("B", "A")].join("").repeat(6) + // 6-6
    "AAAAAAA" + // tie-break 7-0, set one to ROU
    [set("A", "B"), set("B", "A")].join("").repeat(6) +
    "BBBBBBB" + // set two to USA
    "ABABABABABABABABAAA"; // the match tie-break, long, to ROU
  const { states } = rubber(pattern);
  const calls = states.slice(1).map((to, i) => ({ from: states[i], to, ids: callForTransition(states[i], to, INFO, doubles) }));

  it("reaches a match tie-break and ends there", () => {
    const last = states[states.length - 1];
    expect(last.completedSets).toHaveLength(3);
    expect(last.completedSets[2].matchTiebreak).toBe(true);
    expect(last.winner).toBe("A");
  });

  it("says something for every point, and only clips the pack holds", () => {
    for (const c of calls) {
      expect(c.ids, JSON.stringify(c.to.teamA) + JSON.stringify(c.to.teamB)).not.toBeNull();
      for (const id of c.ids!) expect(id in PHRASES, id).toBe(true);
    }
  });

  it("changes ends exactly when the rules say", () => {
    for (const c of calls) {
      expect(c.ids!.includes("change-ends")).toBe(endsChange(c.from, c.to).changeEnds);
    }
    // After game one and every odd game, and every six points of a tie-break.
    expect(calls.filter((c) => c.ids!.includes("change-ends")).length).toBeGreaterThan(12);
  });

  it("calls deciding points, the match tie-break, the nations and the result", () => {
    const all = calls.flatMap((c) => c.ids!);
    const fortyAll = states.filter((s) => !s.isTiebreak && s.teamA.points === "40" && s.teamB.points === "40").length;
    expect(fortyAll).toBeGreaterThan(10);
    expect(all.filter((id) => id === "deciding-point")).toHaveLength(fortyAll);
    // At forty all it is a deciding point, never a break point; at thirty-forty it is still one.
    const atFortyAll = calls.filter((c) => !c.to.isTiebreak && c.to.teamA.points === "40" && c.to.teamB.points === "40");
    for (const c of atFortyAll) expect(c.ids).not.toContain("break-point");
    expect(all).toContain("break-point");
    expect(all.filter((id) => id === "match-tie-break")).toHaveLength(1);
    expect(all).toContain("tie-break");
    expect(all).toContain("nation-ROU");
    expect(all).toContain("nation-USA");
    expect(all).not.toContain("team-red");
    expect(calls[calls.length - 1].ids).toEqual(["game-set-match-named", "nation-ROU"]);
    // Past seven points a side, the tie-break is read from number words.
    expect(calls.some((c) => c.to.isMatchTiebreak && c.ids!.includes("n-9"))).toBe(true);
    expect(all).toContain("match-point");
  });

  it("is still called on the released en-v2 pack, without the calls it lacks", () => {
    const index = JSON.parse(
      readFileSync(fileURLToPath(new URL(`../../../public/voice/${PREVIOUS_VOICE_PACKS[0]}/pack.json`, import.meta.url)), "utf8"),
    ) as PackIndex;
    const has = (id: string) => Boolean(index.clips[id]);
    // Everything but the tennis clips is in the older pack.
    expect(Object.keys(PHRASES).filter((id) => !has(id) && !isTennisClip(id))).toEqual([]);
    for (const c of calls) {
      // Without the nation clips the hook names no one: server and receiver.
      const plain = callForTransition(c.from, c.to, { ...INFO, sides: null }, doubles);
      const said = supportedCall(plain, has);
      expect(said).not.toBeNull();
      expect(said!.some(isTennisClip)).toBe(false);
    }
    // A missing name is never half-said: the call is refused instead.
    expect(supportedCall(["game-named", "nation-ROU"], has)).toBeNull();
  });
});
