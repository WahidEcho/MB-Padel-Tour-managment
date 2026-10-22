import { describe, expect, it } from "vitest";
import { FINAL_HOLD_MS, OVERLAY_ALIVE_KEY, OVERLAY_WATCHDOG, overlayMatch, overlayModel, overlayOptions, resolveCourtParam, shortName, surname, type OverlayInput, type OverlayMatchInfo } from "./overlay";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../scoring/engine";
import { ace as playAce } from "../scoring/serve";
import { startClock } from "../scoring/timing";
import { scoringConfigForMatch } from "../scoring/rules";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";
import type { LiveMatch, LiveSnapshot } from "../tv/liveFeed";

const T0 = Date.parse("2026-11-02T09:30:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const rules = scoringConfigForMatch({ sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG }, { stage: "group" });

const match = (id: string, over: Partial<LiveMatch> = {}): LiveMatch => ({
  id, status: "scheduled", stage: "group", court_id: "c13", bracket_id: null, round_name: "Group A", match_order: 1, scheduled_time: at(0),
  team_a_id: "EGY", team_b_id: "USA", winner_team_id: null, started_at: null, ended_at: null, ...over,
});
const info = (id: string, no: number, type: string, a: string[], b: string[]): OverlayMatchInfo => ({
  id, tie_id: "t1", rubber_no: no, rubber_type: type, a, b, round_name: "Group A", rules,
});
const snapOf = (id: string, s: ScoreState, n: number): LiveSnapshot => ({
  match_id: id, last_event_number: n, last_undo_event_number: 0,
  points: [s.teamA.points, s.teamB.points], games: [s.teamA.games, s.teamB.games], sets: [s.teamA.sets, s.teamB.sets],
  tiebreak: s.isTiebreak, match_tiebreak: Boolean(s.isMatchTiebreak), tiebreak_points: [s.teamA.tiebreakPoints, s.teamB.tiebreakPoints],
  serving_team_id: s.servingTeam === "A" ? "EGY" : s.servingTeam === "B" ? "USA" : null, completed_sets: s.completedSets, match_over: s.matchOver,
  ...(s.matchOver ? {} : { state: s }),
});
function play(points: TeamKey[], from = initialScoreState("A")): ScoreState {
  return points.reduce((s, p) => awardPoint(s, p, rules), from);
}
const games = (team: TeamKey, n: number): TeamKey[] => Array.from({ length: n * 4 }, () => team);

const base = (over: Partial<OverlayInput> = {}): OverlayInput => ({
  courtId: "c13",
  courtName: "Court 13 (boys)",
  title: "Davis Cup Juniors",
  matches: [],
  snapshots: [],
  info: {
    r1: info("r1", 1, "S2", ["e2"], ["u2"]),
    r2: info("r2", 2, "S1", ["e1"], ["u1"]),
    r3: info("r3", 3, "D", ["e1", "e2"], ["u1", "u2"]),
  },
  teams: {
    EGY: { id: "EGY", code: "EGY", iso2: "eg", name: "Egypt", players: [{ id: "e1", name: "Omar Ali Hassan" }, { id: "e2", name: "Karim Fathy" }] },
    USA: { id: "USA", code: "USA", iso2: "us", name: "United States", players: [{ id: "u1", name: "Jack Smith" }, { id: "u2", name: "Leo Brown" }] },
  },
  ties: [{ id: "t1", court_id: "c13", tie_order: 1, team_a_id: "EGY", team_b_id: "USA", round_name: "Group A" }],
  now: T0 + 60_000,
  switches: { aces: true, timers: true },
  timeZone: "Africa/Cairo",
  ...over,
});

describe("broadcast overlay view model", () => {
  it("a live rubber: header with the tie score, sets, games, points and the server", () => {
    const s = play([...games("A", 6), ...games("B", 6), ...games("A", 2), "A", "A", "B"]);
    // r2 (S1) is on court; r1 was won by Egypt.
    const m = base({
      matches: [
        match("r1", { status: "completed", winner_team_id: "EGY", started_at: at(-9_000_000), ended_at: at(-1_000_000) }),
        match("r2", { status: "live", started_at: at(0) }),
        match("r3"),
      ],
      snapshots: [snapOf("r2", s, 50)],
    });
    const v = overlayModel(m);
    expect(v.kind).toBe("live");
    if (v.kind !== "live") return;
    expect(v.header).toEqual(["Davis Cup Juniors", "EGY 1–0 USA", "S1"]);
    expect(v.rows[0]).toMatchObject({ code: "EGY", iso2: "eg", names: ["O. Hassan"], games: 2, points: "30" });
    expect(v.rows[1]).toMatchObject({ code: "USA", names: ["J. Smith"], games: 0, points: "15" });
    expect(v.rows[0].sets).toEqual([{ games: 6, tb: null, won: true }, { games: 0, tb: null, won: false }]);
    expect(v.rows[1].sets.map((x) => x.games)).toEqual([0, 6]);
    expect(v.rows.filter((r) => r.serving)).toHaveLength(1);
    expect(v.label).toBe("Points");
    expect(v.eventNumber).toBe(50);
  });

  it("another court's match never reaches this bug", () => {
    const s = play(["A"]);
    const v = overlayModel(base({ ties: [], info: {}, matches: [match("x", { status: "live", court_id: "c14", started_at: at(0) })], snapshots: [snapOf("x", s, 1)] }));
    expect(v.kind).toBe("idle");
    expect(v.header).toEqual(["Davis Cup Juniors", "Court 13 (boys)"]);
  });

  it("ACE and a running changeover show when the organiser's switches say so", () => {
    const aced = playAce(play(["A"]), rules)!.next;
    const live = { matches: [match("r1", { status: "live", started_at: at(0) })], snapshots: [snapOf("r1", aced, 2)] };
    const on = overlayModel(base(live));
    expect(on.kind === "live" && on.ace).toBe(true);
    const off = overlayModel(base({ ...live, switches: { aces: false, timers: false } }));
    expect(off.kind === "live" && off.ace).toBe(false);

    const timed = startClock(play(games("A", 1)), "changeover", at(30_000));
    const c = overlayModel(base({ matches: live.matches, snapshots: [snapOf("r1", timed, 5)], now: T0 + 75_000 }));
    expect(c.kind === "live" && c.clock).toMatchObject({ label: "Changeover", text: "0:45", over: false });
    // A running timer takes the callout's place.
    expect(c.kind === "live" && c.callout).toBe(null);
    const noTimers = overlayModel(base({ matches: live.matches, snapshots: [snapOf("r1", timed, 5)], now: T0 + 75_000, switches: { aces: true, timers: false } }));
    expect(noTimers.kind === "live" && noTimers.clock).toBe(null);
  });

  it("a doubles rubber names both players and marks which one serves", () => {
    const s = play(["A"]);
    const v = overlayModel(base({ matches: [match("r3", { status: "live", started_at: at(0) })], snapshots: [snapOf("r3", s, 1)] }));
    if (v.kind !== "live") throw new Error(v.kind);
    expect(v.rows[0].names).toEqual(["O. Hassan", "K. Fathy"]);
    expect(v.rows[0].surnames).toEqual(["Hassan", "Fathy"]);
    expect(v.rows[0].servingIndex).toBe(0);
    expect(v.rows[1].servingIndex).toBe(null);
  });

  it("holds the final score, then moves on to the next rubber on the court", () => {
    const s = play([...games("A", 6), ...games("A", 6)]);
    const matches = [match("r1", { status: "completed", winner_team_id: "EGY", started_at: at(0), ended_at: at(30_000) }), match("r2", { status: "ready", scheduled_time: at(3_600_000) })];
    const fin = overlayModel(base({ matches, snapshots: [snapOf("r1", s, 48)], now: T0 + 60_000 }));
    expect(fin.kind).toBe("final");
    if (fin.kind !== "final") return;
    expect(fin.header).toEqual(["Davis Cup Juniors", "EGY 1–0 USA", "S2", "Final"]);
    expect(fin.rows[0]).toMatchObject({ winner: true, points: null, games: null });
    expect(fin.rows[0].sets.map((x) => x.games)).toEqual([6, 6]);

    const next = overlayModel(base({ matches, snapshots: [snapOf("r1", s, 48)], now: T0 + 30_000 + FINAL_HOLD_MS + 1 }));
    expect(next.kind).toBe("next");
    if (next.kind !== "next") return;
    expect(next.matchId).toBe("r2");
    // 10:30 UTC is 12:30 in Cairo (UTC+2 in November).
    expect(next.header).toEqual(["Davis Cup Juniors", "EGY 1–0 USA", "S1", "Next · 12:30"]);
    expect(next.rows.map((r) => r.names)).toEqual([["O. Hassan"], ["J. Smith"]]);
  });

  it("a tie-break shows tie-break points and the loser's tie-break score after the set", () => {
    const s = play([...Array.from({ length: 6 }, () => [...games("A", 1), ...games("B", 1)]).flat(), "A", "B", "B"]);
    const v = overlayModel(base({ matches: [match("r1", { status: "live", started_at: at(0) })], snapshots: [snapOf("r1", s, 60)] }));
    if (v.kind !== "live") throw new Error(v.kind);
    expect(v.label).toBe("Tie-break");
    expect(v.rows.map((r) => r.points)).toEqual(["1", "2"]);
    expect(v.rows.map((r) => r.games)).toEqual([6, 6]);
  });

  it("a team event without ties: the team's name and the round", () => {
    const s = play(["B"]);
    const v = overlayModel(base({
      ties: [],
      info: { m1: { id: "m1", tie_id: null, rubber_no: null, rubber_type: null, a: [], b: [], round_name: "Semi-final", rules } },
      teams: { A1: { id: "A1", code: "AHM", iso2: null, name: "Ahmed / Omar", players: [] }, B1: { id: "B1", code: "KAR", iso2: null, name: "Karim / Ali", players: [] } },
      matches: [match("m1", { status: "live", team_a_id: "A1", team_b_id: "B1", round_name: "Semi-final", started_at: at(0) })],
      snapshots: [snapOf("m1", s, 1)],
    }));
    if (v.kind !== "live") throw new Error(v.kind);
    expect(v.header).toEqual(["Davis Cup Juniors", "Semi-final"]);
    expect(v.rows.map((r) => r.names[0])).toEqual(["Ahmed / Omar", "Karim / Ali"]);
  });

  it("a rubber with no nominees yet shows the nation on the bar", () => {
    const v = overlayModel(base({
      info: { r1: { ...info("r1", 1, "S2", [], []) } },
      matches: [match("r1", { status: "live", started_at: at(0) })],
      snapshots: [snapOf("r1", play(["A"]), 1)],
    }));
    expect(v.kind === "live" && v.rows.map((r) => r.surnames)).toEqual([["Egypt"], ["United States"]]);
  });

  it("names: initial and surname", () => {
    expect(surname("Giulia Safina Popa")).toBe("Popa");
    expect(shortName("Giulia Safina Popa")).toBe("G. Popa");
    expect(shortName("Pele")).toBe("Pele");
  });

  it("reads its URL switches, bounded", () => {
    expect(overlayOptions({})).toEqual({ bug: true, footer: true, idle: true, scale: 1 });
    expect(overlayOptions({ bug: "0", footer: "1", scale: "1.25" })).toEqual({ bug: false, footer: true, idle: true, scale: 1.25 });
    expect(overlayOptions({ scale: "9", idle: "off" })).toMatchObject({ scale: 2, idle: false });
    expect(overlayOptions({ scale: "nope" }).scale).toBe(1);
  });

  it("finds the court by id, name or slug", () => {
    const courts = [
      { id: "c-13", court_name: "Court 13 (boys)", court_order: 2 },
      { id: "c-14", court_name: "Court 14 (girls)", court_order: 3 },
    ];
    expect(resolveCourtParam(courts, "c-14")?.id).toBe("c-14");
    expect(resolveCourtParam(courts, "court%2013%20(boys)")?.id).toBe("c-13");
    expect(resolveCourtParam(courts, "court-14-girls")?.id).toBe("c-14");
    expect(resolveCourtParam(courts, "court-15")).toBeUndefined();
  });

  /*
   * J200 Cairo, 22 Oct 2026. Court 1 (id c1) played the boys' singles SF Martin v
   * Genidy; Court 5 (id c5) had the "Round 2 Double" Kaliadina / Nuneva v
   * Bernstein / Shen started at 10:06 and its score last moved at 10:56. Each
   * court's overlay must show its own match, by court id, whatever else is live.
   */
  describe("J200 Cairo: each court shows its own match", () => {
    const D = Date.parse("2026-10-22T10:00:00Z");
    const iso = (min: number) => new Date(D + min * 60_000).toISOString();
    const singles = (id: string): OverlayMatchInfo => ({ id, tie_id: null, rubber_no: null, rubber_type: null, a: [], b: [], round_name: null, rules });
    const j200 = (over: Partial<OverlayInput> = {}): OverlayInput =>
      base({
        title: "J200 Cairo · Singles & Doubles",
        ties: [],
        teams: {
          MAR: { id: "MAR", code: "FRA", iso2: "fr", name: "Matisse Martin", players: [{ id: "p1", name: "Matisse Martin" }] },
          GEN: { id: "GEN", code: "EGY", iso2: "eg", name: "Mohamed Genidy", players: [{ id: "p2", name: "Mohamed Genidy" }] },
          KN: { id: "KN", code: "KN", iso2: null, name: "Kaliadina / Nuneva", players: [{ id: "p3", name: "Eva Kaliadina" }, { id: "p4", name: "Nikol Nuneva" }] },
          BS: { id: "BS", code: "BS", iso2: null, name: "Bernstein / Shen", players: [{ id: "p5", name: "Amy Shen" }, { id: "p6", name: "Grace Bernstein" }] },
        },
        info: { sf: singles("sf"), r2: { ...singles("r2"), round_name: "Round 2 Double" } },
        matches: [
          match("sf", { status: "live", court_id: "c1", round_name: "Boys' Singles SF", team_a_id: "MAR", team_b_id: "GEN", started_at: iso(-172) }),
          match("r2", { status: "live", court_id: "c5", round_name: "Round 2 Double", team_a_id: "KN", team_b_id: "BS", started_at: iso(6) }),
        ],
        snapshots: [
          { ...snapOf("sf", play(games("B", 3)), 200), updated_at: iso(13) },
          { ...snapOf("r2", play(["B", "A", "B"]), 5), updated_at: iso(56) },
        ],
        now: D + 60 * 60_000,
        ...over,
      });

    it("Court 5's overlay is Court 5's doubles, never Court 1's singles (and the other way round)", () => {
      const c5 = overlayModel(j200({ courtId: "c5", courtName: "Court 5" }));
      if (c5.kind !== "live") throw new Error(c5.kind);
      expect(c5.matchId).toBe("r2");
      expect(c5.header).toEqual(["J200 Cairo · Singles & Doubles", "Round 2 Double"]);
      expect(c5.rows.map((r) => r.names.join(" / "))).toEqual(["Kaliadina / Nuneva", "Bernstein / Shen"]);
      const c1 = overlayModel(j200({ courtId: "c1", courtName: "Court 1" }));
      expect(c1.kind === "live" && c1.matchId).toBe("sf");
      expect(c1.kind === "live" && c1.rows.map((r) => r.code)).toEqual(["FRA", "EGY"]);
    });

    it("the bar prints surnames: a singles entry's player, a pair as the organiser named it", () => {
      const c5 = overlayModel(j200({ courtId: "c5", courtName: "Court 5" }));
      if (c5.kind !== "live") throw new Error(c5.kind);
      // The pair's players are stored Shen, Bernstein; the bar follows the entry's name.
      expect(c5.rows.map((r) => r.surnames)).toEqual([["Kaliadina", "Nuneva"], ["Bernstein", "Shen"]]);
      expect(c5.rows.map((r) => r.servingIndex)).toEqual([null, null]);
      const c1 = overlayModel(j200({ courtId: "c1", courtName: "Court 1" }));
      expect(c1.kind === "live" && c1.rows.map((r) => r.surnames)).toEqual([["Martin"], ["Genidy"]]);
    });

    it("a court with nothing in play shows its idle strip, not another court's match", () => {
      const v = overlayModel(j200({ courtId: "c2", courtName: "Court 2" }));
      expect(v.kind).toBe("idle");
      expect(v.header).toEqual(["J200 Cairo · Singles & Doubles", "Court 2"]);
    });

    it("two matches left live on one court: the one whose score moved last, not the one started last", () => {
      const input = j200({
        courtId: "c5",
        matches: [
          match("r2", { status: "live", court_id: "c5", team_a_id: "KN", team_b_id: "BS", started_at: iso(6) }),
          match("sf", { status: "live", court_id: "c5", team_a_id: "MAR", team_b_id: "GEN", started_at: iso(-30) }),
        ],
        snapshots: [
          { ...snapOf("r2", play(["B"]), 2), updated_at: iso(7) },
          { ...snapOf("sf", play(games("B", 3)), 90), updated_at: iso(58) },
        ],
      });
      expect(overlayMatch(input)?.match.id).toBe("sf");
    });

    it("a match left live after another one finished on the court is not what the camera shows", () => {
      const input = j200({
        courtId: "c5",
        matches: [
          match("r2", { status: "live", court_id: "c5", team_a_id: "KN", team_b_id: "BS", started_at: iso(6) }),
          match("sf", { status: "completed", court_id: "c5", team_a_id: "MAR", team_b_id: "GEN", winner_team_id: "GEN", started_at: iso(68), ended_at: iso(135) }),
        ],
        snapshots: [{ ...snapOf("r2", play(["B"]), 2), updated_at: iso(7) }],
        now: D + 136 * 60_000,
      });
      expect(overlayMatch(input)).toMatchObject({ kind: "final", match: { id: "sf" } });
      // The result stays until the court's next match starts, or FINAL_HOLD_MS at most.
      expect(overlayModel({ ...input, now: D + 200 * 60_000 }).kind).toBe("final");
      expect(overlayModel({ ...input, now: D + 135 * 60_000 + FINAL_HOLD_MS + 1 }).kind).toBe("idle");
    });
  });

  it("the page watchdog is plain ES5 and reloads only when the client stops drawing", () => {
    expect(OVERLAY_WATCHDOG).not.toMatch(/=>|\blet\b|\bconst\b|`/);
    expect(OVERLAY_WATCHDOG).toContain(OVERLAY_ALIVE_KEY);
    let tick: (() => void) | null = null;
    let reloaded = 0;
    const win: Record<string, number> = {};
    const doc = { hidden: false };
    const clock = { t: 1_000 };
    new Function("window", "document", "location", "setInterval", "Date", OVERLAY_WATCHDOG)(
      win, doc, { reload: () => reloaded++ }, (f: () => void) => { tick = f; }, { now: () => clock.t },
    );
    clock.t += 20_000; tick!();
    expect(reloaded).toBe(0);
    win[OVERLAY_ALIVE_KEY] = clock.t;
    clock.t += 25_000; tick!();
    expect(reloaded).toBe(0);
    clock.t += 10_000; tick!();
    expect(reloaded).toBe(1);
    doc.hidden = true; clock.t += 120_000; tick!();
    expect(reloaded).toBe(1);
  });
});
