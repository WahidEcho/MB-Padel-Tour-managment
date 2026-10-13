import { describe, expect, it } from "vitest";
import type { MCourtCall, MCourtsEvent, MMatch, MStageRules, MTie } from "../mobile/contract";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";
import { DEFAULT_MATCH_DAY_RULES, OFF_MATCH_DAY_RULES } from "../matchday/rules";
import {
  RESULT_REST_MS,
  RUBBER_WON_MS,
  TIE_FINAL_MS,
  WALKON,
  courtScene,
  heroCards,
  isLiveScene,
  nextAfter,
  rulesForMatch,
  sceneMatchIds,
  showcaseOn,
  showcaseSubset,
  sideIdentity,
  sideName,
  sidePlayers,
} from "./showcase";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let n = 0;
const match = (over: Partial<MMatch>): MMatch => ({
  id: `m${++n}`,
  tieId: null,
  rubberNo: null,
  rubberType: null,
  stage: "group",
  groupId: null,
  round: null,
  order: n,
  courtId: "c1",
  scheduledTime: null,
  status: "scheduled",
  a: "ta",
  b: "tb",
  aPlayers: [],
  bPlayers: [],
  winner: null,
  startedAt: null,
  endedAt: null,
  score: null,
  ...over,
});

const score = (lastEventNumber: number) => ({
  sets: [],
  games: { a: 0, b: 0 },
  points: { a: "0", b: "0" },
  tiebreak: false,
  serving: "A" as const,
  setsWon: { a: 0, b: 0 },
  lastEventNumber,
  lastUndo: 0,
  updatedAt: null,
});

const tie = (over: Partial<MTie>): MTie => ({
  id: `t${++n}`,
  stage: "group",
  groupId: null,
  roundNo: 1,
  roundName: null,
  order: 1,
  courtId: "c1",
  scheduledTime: null,
  a: "ta",
  b: "tb",
  status: "scheduled",
  rubbersA: 0,
  rubbersB: 0,
  winner: null,
  placesFrom: null,
  placesTo: null,
  lineupLocked: false,
  ...over,
});

const call = (matchId: string, over: Partial<MCourtCall> = {}): MCourtCall => ({
  matchId,
  courtId: "c1",
  calledAt: ago(60_000),
  deadlineAt: new Date(NOW + 4 * 60_000).toISOString(),
  extensions: 0,
  presentA: true,
  presentB: false,
  ...over,
});

describe("courtScene: one-match fixtures (padel and the rest)", () => {
  it("is idle with nothing on the court", () => {
    expect(courtScene("c1", [], [match({ courtId: "c2" })], [], NOW)).toEqual({ kind: "idle" });
  });

  it("shows the next fixture by scheduled time, then match order", () => {
    const later = match({ scheduledTime: ago(-3600_000) });
    const sooner = match({ scheduledTime: ago(-600_000) });
    expect(courtScene("c1", [], [later, sooner], [], NOW)).toEqual({ kind: "next", tieId: null, matchId: sooner.id });
  });

  it("walks each side on as a match starts, then shows the live score", () => {
    const m = match({ status: "live", startedAt: ago(2_000), score: score(1) });
    expect(courtScene("c1", [], [m], [], NOW)).toMatchObject({ kind: "walkon", matchId: m.id, side: "A", elapsedMs: 2_000 });
    const b = { ...m, startedAt: ago(WALKON.perSideMs + 1_000) };
    expect(courtScene("c1", [], [b], [], NOW)).toMatchObject({ kind: "walkon", side: "B", elapsedMs: 1_000 });
    const over = { ...m, startedAt: ago(WALKON.totalMs + 1) };
    expect(courtScene("c1", [], [over], [], NOW)).toEqual({ kind: "live", tieId: null, matchId: m.id });
  });

  it("skips the walk-on once points are scored, and for a paused match", () => {
    expect(courtScene("c1", [], [match({ status: "live", startedAt: ago(1_000), score: score(4) })], [], NOW).kind).toBe("live");
    expect(courtScene("c1", [], [match({ status: "paused", startedAt: ago(1_000), score: score(1) })], [], NOW).kind).toBe("live");
  });

  it("never rewinds when the phone's clock is a little behind the server's", () => {
    const m = match({ status: "live", startedAt: new Date(NOW + 3_000).toISOString(), score: score(1) });
    expect(courtScene("c1", [], [m], [], NOW)).toMatchObject({ kind: "walkon", side: "A", elapsedMs: 0 });
  });

  it("holds the result as a moment, then stilled, then moves on to the next fixture", () => {
    const done = match({ status: "completed", winner: "ta", endedAt: ago(3_000) });
    const next = match({ status: "scheduled" });
    expect(courtScene("c1", [], [done, next], [], NOW)).toMatchObject({ kind: "result", matchId: done.id, fresh: true });
    const rested = { ...done, endedAt: ago(RUBBER_WON_MS + 1_000) };
    expect(courtScene("c1", [], [rested, next], [], NOW)).toMatchObject({ kind: "result", matchId: done.id, fresh: false });
    const old = { ...done, endedAt: ago(RESULT_REST_MS + 1_000) };
    expect(courtScene("c1", [], [old, next], [], NOW)).toEqual({ kind: "next", tieId: null, matchId: next.id });
  });

  it("puts a live match before a result on the same court", () => {
    const done = match({ status: "completed", endedAt: ago(1_000) });
    const live = match({ status: "live", startedAt: ago(60_000), score: score(9) });
    expect(courtScene("c1", [], [done, live], [], NOW).kind).toBe("live");
  });

  it("shows a match called to court with its countdown and who is here", () => {
    const m = match({ status: "ready" });
    const s = courtScene("c1", [], [m], [call(m.id)], NOW);
    expect(s).toMatchObject({ kind: "called", matchId: m.id, msLeft: 4 * 60_000, overdue: false, presentA: true, presentB: false });
    const late = courtScene("c1", [], [m], [call(m.id, { deadlineAt: ago(1_000) })], NOW);
    expect(late).toMatchObject({ kind: "called", msLeft: 0, overdue: true });
  });

  it("ignores a call for a match that already started or is on another court", () => {
    const live = match({ status: "live", startedAt: ago(60_000), score: score(5) });
    expect(courtScene("c1", [], [live], [call(live.id)], NOW).kind).toBe("live");
    const elsewhere = match({ status: "ready", courtId: "c2" });
    expect(courtScene("c1", [], [elsewhere], [call(elsewhere.id)], NOW)).toEqual({ kind: "idle" });
  });

  it("places a call by the call's court when the match has none", () => {
    const m = match({ status: "ready", courtId: null });
    expect(courtScene("c1", [], [m], [call(m.id, { courtId: "c1" })], NOW).kind).toBe("called");
  });

  it("names what is next after the live match", () => {
    const live = match({ status: "live", startedAt: ago(60_000), score: score(9) });
    const next = match({ status: "scheduled" });
    const scene = courtScene("c1", [], [live, next], [], NOW);
    expect(nextAfter("c1", scene, [], [live, next])).toEqual({ tieId: null, matchId: next.id });
    expect(nextAfter("c1", { kind: "next", tieId: null, matchId: next.id }, [], [live, next])).toBeNull();
  });
});

describe("courtScene: ties of rubbers", () => {
  const T = tie({});
  const rubber = (no: number, over: Partial<MMatch> = {}) => match({ tieId: T.id, rubberNo: no, rubberType: ["S2", "S1", "D"][no - 1], courtId: null, ...over });

  it("shows the line-up of the next tie", () => {
    const rs = [rubber(1), rubber(2), rubber(3)];
    expect(courtScene("c1", [T], rs, [], NOW)).toEqual({ kind: "next", tieId: T.id, matchId: null });
  });

  it("follows a rubber on its tie's court, and shows the tie score between rubbers", () => {
    const rs = [rubber(1, { status: "completed", winner: "ta", endedAt: ago(RUBBER_WON_MS + 1) }), rubber(2), rubber(3)];
    expect(courtScene("c1", [T], rs, [], NOW)).toEqual({ kind: "tie_score", tieId: T.id, final: false });
    const fresh = [{ ...rs[0]!, endedAt: ago(1_000) }, rs[1]!, rs[2]!];
    expect(courtScene("c1", [T], fresh, [], NOW)).toMatchObject({ kind: "result", tieId: T.id, fresh: true });
    expect(nextAfter("c1", courtScene("c1", [T], fresh, [], NOW), [T], fresh)).toEqual({ tieId: T.id, matchId: rs[1]!.id });
  });

  it("keeps a finished tie's final score for a while, then the next tie's line-up", () => {
    const T2 = tie({ order: 2 });
    const done = [rubber(1, { status: "completed", endedAt: ago(60_000) }), rubber(2, { status: "completed", endedAt: ago(30_000) }), rubber(3, { status: "cancelled" })];
    const next = [match({ tieId: T2.id, rubberNo: 1, courtId: null })];
    expect(courtScene("c1", [T, T2], [...done, ...next], [], NOW)).toEqual({ kind: "tie_score", tieId: T.id, final: true });
    const old = done.map((r) => (r.endedAt ? { ...r, endedAt: ago(TIE_FINAL_MS + 60_000) } : r));
    expect(courtScene("c1", [T, T2], [...old, ...next], [], NOW)).toEqual({ kind: "next", tieId: T2.id, matchId: null });
  });

  it("puts a called rubber before the tie score", () => {
    const rs = [rubber(1, { status: "completed", endedAt: ago(60_000) }), rubber(2, { status: "ready" })];
    expect(courtScene("c1", [T], rs, [call(rs[1]!.id)], NOW).kind).toBe("called");
  });
});

const rules: MStageRules = {
  base: { setsToWinMatch: 1, gamesToWinSet: 6, tiebreakEnabled: true, tiebreakAtGames: 6, tiebreakTargetPoints: 7, tiebreakWinByTwo: true, walkoverScore: "6-0" },
  stages: {
    group: { setsToWinMatch: 1, gamesToWinSet: 6, tiebreakEnabled: true, tiebreakAtGames: 6, tiebreakTargetPoints: 7, tiebreakWinByTwo: true, walkoverScore: "6-0" },
    quarter_semi: { setsToWinMatch: 1, gamesToWinSet: 9, tiebreakEnabled: true, tiebreakAtGames: 8, tiebreakTargetPoints: 7, tiebreakWinByTwo: true, walkoverScore: "9-0" },
    final: { setsToWinMatch: 2, gamesToWinSet: 6, tiebreakEnabled: true, tiebreakAtGames: 6, tiebreakTargetPoints: 7, tiebreakWinByTwo: true, walkoverScore: "6-0" },
    bracket: { setsToWinMatch: 1, gamesToWinSet: 6, tiebreakEnabled: true, tiebreakAtGames: 6, tiebreakTargetPoints: 7, tiebreakWinByTwo: true, walkoverScore: "6-0" },
    plate_quarter_semi: { setsToWinMatch: 1, gamesToWinSet: 4, tiebreakEnabled: true, tiebreakAtGames: 4, tiebreakTargetPoints: 7, tiebreakWinByTwo: true, walkoverScore: "4-0" },
    plate_final: { setsToWinMatch: 1, gamesToWinSet: 6, tiebreakEnabled: true, tiebreakAtGames: 6, tiebreakTargetPoints: 7, tiebreakWinByTwo: true, walkoverScore: "6-0" },
    plate_bracket: { setsToWinMatch: 1, gamesToWinSet: 4, tiebreakEnabled: true, tiebreakAtGames: 4, tiebreakTargetPoints: 7, tiebreakWinByTwo: true, walkoverScore: "4-0" },
  },
  doubles: DEFAULT_TENNIS_SCORING_CONFIG.doubles!,
  plateBrackets: ["plate1"],
};

describe("rulesForMatch", () => {
  it("finds the stage bucket, the Plate by its bracket, and lays the doubles rules on top", () => {
    expect(rulesForMatch(rules, match({ stage: "final", bracketId: "cup1" })).setsToWinMatch).toBe(2);
    expect(rulesForMatch(rules, match({ stage: "semi_final", bracketId: "plate1" })).gamesToWinSet).toBe(4);
    expect(rulesForMatch(rules, match({ stage: "semi_final", bracketId: "cup1" })).gamesToWinSet).toBe(9);
    expect(rulesForMatch(rules, match({ stage: "friendly" }))).toEqual(rules.base);
    const d = rulesForMatch(rules, match({ stage: "final", rubberType: "D" }));
    expect(d.matchTiebreak).toBe(true);
    expect(d.setsToWinMatch).toBe(2);
    expect(rulesForMatch(rules, match({ stage: "final", rubberType: "S1", aPlayers: ["p"], bPlayers: ["q"] })).matchTiebreak).toBeUndefined();
  });

  it("uses the base rules for a stage it does not know", () => {
    expect(rulesForMatch(rules, match({ stage: "round_of_99" }))).toEqual(rules.base);
  });
});

describe("sides", () => {
  const sides = { redBlue: true, A: { label: "Red team", short: "RED", hex: "#dc2626" }, B: { label: "Blue team", short: "BLUE", hex: "#2563eb" } };
  const egypt = { name: "Egypt", code: "EGY", iso2: "eg" };

  it("is red and blue, with the word, when the organiser turned them on", () => {
    expect(sideIdentity(egypt, "A", sides)).toEqual({ kind: "colour", hex: "#dc2626", code: "EGY", label: "Egypt", word: "RED" });
    expect(sideIdentity(egypt, "B", sides)).toMatchObject({ word: "BLUE" });
  });

  it("is a nation's flag, else a logo, else the event's colour for the side", () => {
    const off = { ...sides, redBlue: false };
    expect(sideIdentity(egypt, "A", off)).toEqual({ kind: "flag", iso2: "eg", code: "EGY", label: "Egypt" });
    expect(sideIdentity({ name: "Falcons", code: "FAL", logoUrl: "https://x/l.png" }, "A", off).kind).toBe("logo");
    expect(sideIdentity({ name: "Falcons", code: "FAL" }, "B", off, { seedA: "#111111", seedB: "#222222" })).toMatchObject({ kind: "colour", hex: "#222222", word: null });
    expect(sideIdentity({ name: "Falcons", code: "FAL" }, "A", null, { seedA: "junk" })).toMatchObject({ kind: "colour", hex: "#d8572a" });
    expect(sideIdentity(null, "A")).toMatchObject({ code: "TBD" });
  });

  it("finds the players of a side: nominated, else the team outside ties", () => {
    const event = {
      teams: [
        { id: "ta", name: "Taymour / Mohsen", code: "TM", iso2: null, players: [{ id: "p1", name: "Ali Taymour", teamId: "ta", photoUrl: null, focalX: 0.5, focalY: 0.35 }, { id: "p2", name: "Omar Mohsen", teamId: "ta", photoUrl: null, focalX: 0.5, focalY: 0.35 }] },
        { id: "tb", name: "Egypt", code: "EGY", iso2: "eg", players: [{ id: "p3", name: "Adam Hassan", teamId: "tb", photoUrl: null, focalX: 0.5, focalY: 0.35 }] },
      ],
    };
    const padel = match({});
    expect(sidePlayers(event, padel, "A").map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(sideName(event, padel, "A")).toBe("Taymour / Mohsen");
    const rubber = match({ tieId: "t", bPlayers: ["p3"] });
    expect(sidePlayers(event, rubber, "A")).toEqual([]);
    expect(sideName(event, rubber, "B", true)).toBe("Hassan");
  });
});

describe("showcaseOn", () => {
  const t = { status: "active", sport: "padel", timezone: "Africa/Cairo", starts_on: "2026-11-04", ends_on: "2026-11-06" };

  it("follows the Match day switch and event days", () => {
    expect(showcaseOn(t, DEFAULT_MATCH_DAY_RULES, 0, NOW)).toBe(true);
    expect(showcaseOn(t, OFF_MATCH_DAY_RULES, 3, NOW)).toBe(false);
    expect(showcaseOn({ ...t, starts_on: "2026-11-10", ends_on: null }, DEFAULT_MATCH_DAY_RULES, 0, NOW)).toBe(false);
    const always = { ...DEFAULT_MATCH_DAY_RULES, showcase: { on: true, eventDaysOnly: false } };
    expect(showcaseOn({ ...t, starts_on: "2026-11-10", ends_on: null }, always, 0, NOW)).toBe(true);
  });

  it("counts a tournament without dates only while a match is live", () => {
    const undated = { ...t, starts_on: null, ends_on: null };
    expect(showcaseOn(undated, DEFAULT_MATCH_DAY_RULES, 0, NOW)).toBe(false);
    expect(showcaseOn(undated, DEFAULT_MATCH_DAY_RULES, 1, NOW)).toBe(true);
  });

  it("leaves out sports that take no part, and tournaments not running", () => {
    expect(showcaseOn({ ...t, sport: "chess" }, DEFAULT_MATCH_DAY_RULES, 2, NOW)).toBe(false);
    expect(showcaseOn({ ...t, status: "completed" }, DEFAULT_MATCH_DAY_RULES, 2, NOW)).toBe(false);
  });
});

const event = (id: string, over: Partial<MCourtsEvent> = {}): MCourtsEvent => ({
  tournament: { id, slug: id, name: id, sport: "padel", timezone: "Africa/Cairo", eventGroupId: null, isTies: false, showPhotos: true, featured: false, skin: {} },
  rules,
  sides: { redBlue: false, A: { label: "Red team", short: "RED", hex: "#dc2626" }, B: { label: "Blue team", short: "BLUE", hex: "#2563eb" } },
  courts: [
    { id: "c1", name: "Court 1", order: 1 },
    { id: "c2", name: "Court 2", order: 2 },
    { id: "c3", name: "Court 3", order: 3 },
  ],
  teams: [],
  ties: [],
  matches: [],
  calls: [],
  ...over,
});

describe("heroCards", () => {
  it("is empty when nothing is happening, so the hero hides", () => {
    expect(heroCards([event("e1", { matches: [match({ courtId: "c1" })] })], NOW)).toEqual([]);
    expect(heroCards([], NOW)).toEqual([]);
  });

  it("drops idle courts and keeps the Discover order, live courts first within an event", () => {
    const e1 = event("e1", { matches: [match({ courtId: "c1" }), match({ courtId: "c2", status: "live", startedAt: ago(60_000), score: score(9) })] });
    const e2 = event("e2", { matches: [match({ courtId: "c3", status: "live", startedAt: ago(60_000), score: score(9) })] });
    const cards = heroCards([e1, e2], NOW);
    expect(cards.map((c) => c.key)).toEqual(["e1:c2", "e1:c1", "e2:c3"]);
    expect(cards.map((c) => c.live)).toEqual([true, false, true]);
  });

  it("pins the person's own match first, including when it is next on a busy court", () => {
    const mine = match({ courtId: "c2", status: "scheduled", a: "me" });
    const e1 = event("e1", { matches: [match({ courtId: "c1", status: "live", startedAt: ago(60_000), score: score(9) })] });
    const e2 = event("e2", { matches: [match({ courtId: "c2", status: "live", startedAt: ago(60_000), score: score(9) }), mine] });
    const cards = heroCards([e1, e2], NOW, (m) => m.a === "me");
    expect(cards[0]!.key).toBe("e2:c2");
    expect(cards[0]!.mine).toBe(true);
    expect(cards[0]!.next).toEqual({ tieId: null, matchId: mine.id });
  });

  it("lists every match a card is about", () => {
    const T = tie({});
    const r1 = match({ tieId: T.id, rubberNo: 1 });
    const r2 = match({ tieId: T.id, rubberNo: 2 });
    expect(sceneMatchIds({ kind: "next", tieId: T.id, matchId: null }, null, [r1, r2]).sort()).toEqual([r1.id, r2.id].sort());
    expect(isLiveScene({ kind: "next", tieId: null, matchId: "x" })).toBe(false);
    expect(isLiveScene({ kind: "tie_score", tieId: "t", final: true })).toBe(true);
  });
});

describe("showcaseSubset", () => {
  it("keeps what is on, just finished, called and next — not the whole day", () => {
    const live = match({ courtId: "c1", status: "live", startedAt: ago(60_000) });
    const next1 = match({ courtId: "c1", scheduledTime: ago(-600_000) });
    const next2 = match({ courtId: "c1", scheduledTime: ago(-1200_000) });
    const later = match({ courtId: "c1", scheduledTime: ago(-9000_000) });
    const morning = match({ courtId: "c1", status: "completed", endedAt: ago(4 * 3600_000) });
    const justDone = match({ courtId: "c2", status: "completed", endedAt: ago(60_000) });
    const called = match({ courtId: "c2", status: "ready", scheduledTime: ago(-9999_000) });
    const { matchIds } = showcaseSubset(["c1", "c2"], [], [live, next1, next2, later, morning, justDone, called], [call(called.id, { courtId: "c2" })], NOW);
    expect([...matchIds].sort()).toEqual([live.id, next1.id, next2.id, justDone.id, called.id].sort());
  });

  it("keeps a tie in progress and the next tie with all their rubbers", () => {
    const T1 = tie({ order: 1 });
    const T2 = tie({ order: 2 });
    const T3 = tie({ order: 3 });
    const T4 = tie({ order: 4 });
    const r = (t: MTie, over: Partial<MMatch> = {}) => match({ tieId: t.id, courtId: null, ...over });
    const old = r(T1, { status: "completed", endedAt: ago(3 * 3600_000) });
    const live = r(T1, { status: "live", startedAt: ago(60_000) });
    const waiting = r(T2);
    const third = r(T3);
    const fourth = r(T4);
    const s = showcaseSubset(["c1"], [T1, T2, T3, T4], [old, live, waiting, third, fourth], [], NOW);
    expect([...s.tieIds].sort()).toEqual([T1.id, T2.id, T3.id].sort());
    expect(s.matchIds.has(old.id)).toBe(true);
    expect(s.matchIds.has(fourth.id)).toBe(false);
  });
});
