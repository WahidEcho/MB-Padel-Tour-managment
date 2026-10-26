import { describe, expect, it } from "vitest";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../scoring/engine";
import { startClock } from "../scoring/timing";
import { scoringConfigForMatch } from "../scoring/rules";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";
import {
  breakLength,
  breakScene,
  cardAlpha,
  changeoverWhat,
  countdown,
  courtTvFromForm,
  DEFAULT_COURT_TV,
  eventLogoFor,
  eventRecords,
  formatLine,
  isLogoSrc,
  matchClock,
  OFFICIAL_BREAKS,
  partnerSrc,
  sanitizeCourtTv,
  sanitizeHeaderPartners,
  scoreFrom,
  setBreakWhat,
  shortName,
  statCell,
  tieStatus,
} from "./courtTv";

const cfg = scoringConfigForMatch({ sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG }, { stage: "group" });
const play = (s: ScoreState, ...who: TeamKey[]) => who.reduce((x, t) => awardPoint(x, t, cfg), s);
const T0 = Date.parse("2026-11-03T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("settings", () => {
  it("defaults everything on, opacity 55, forest", () => {
    expect(sanitizeCourtTv(undefined)).toEqual(DEFAULT_COURT_TV);
    expect(sanitizeCourtTv("junk")).toEqual(DEFAULT_COURT_TV);
    expect(DEFAULT_COURT_TV).toMatchObject({ glass: true, glassOpacity: 55, breakAnimation: true, breakTimer: true, breakLegend: true, postMatchStats: true });
  });
  it("keeps valid choices, clamps and steps the opacity, drops unknown palettes", () => {
    expect(sanitizeCourtTv({ glass: false, glassOpacity: 12, palette: "noir", postMatchStats: false })).toMatchObject({ glass: false, glassOpacity: 25, palette: "noir", postMatchStats: false, breakTimer: true });
    expect(sanitizeCourtTv({ glassOpacity: 99 }).glassOpacity).toBe(90);
    expect(sanitizeCourtTv({ glassOpacity: 62 }).glassOpacity).toBe(60);
    expect(sanitizeCourtTv({ palette: "pink", glass: "yes" })).toMatchObject({ palette: "forest", glass: true });
  });
  it("card alpha: the opacity with glass, nearly solid without", () => {
    expect(cardAlpha(DEFAULT_COURT_TV)).toBe(0.55);
    expect(cardAlpha({ ...DEFAULT_COURT_TV, glass: false })).toBe(0.92);
  });
});

describe("header logos", () => {
  it("accepts site paths and https only", () => {
    expect(isLogoSrc("/sponsors/cairo-2026/white/world-tennis.png")).toBe(true);
    expect(isLogoSrc("https://tour.mbeg.org/x.png")).toBe(true);
    for (const bad of ["http://x.org/a.png", "//evil.org/a.png", "javascript:alert(1)", "/a/../b.png", "data:image/png;base64,AA", 5]) expect(isLogoSrc(bad)).toBe(false);
  });
  it("partners: cleaned, at most four, light variant by theme", () => {
    const raw = [
      { name: "ETF", logoUrl: "/sponsors/cairo-2026/white/egyptian-tennis-federation-crest.png", logoLightUrl: "/sponsors/cairo-2026/dark/egyptian-tennis-federation-crest.png", aspect: 2.999, height: 57 },
      { name: "Bad", logoUrl: "javascript:x" },
      { name: "WT", logoUrl: "/sponsors/cairo-2026/white/world-tennis.png", logoLightUrl: "http://x", aspect: 99, height: 400 },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, logoUrl: `/p${i}.png` })),
    ];
    const p = sanitizeHeaderPartners(raw);
    expect(p).toHaveLength(4);
    expect(p[0]).toEqual(raw[0]);
    expect(p[1]).toEqual({ name: "WT", logoUrl: "/sponsors/cairo-2026/white/world-tennis.png", height: 96 });
    expect(partnerSrc(p[0], "light")).toContain("/dark/");
    expect(partnerSrc(p[0], "dark")).toContain("/white/");
    expect(partnerSrc(p[1], "light")).toContain("/white/");
    expect(sanitizeHeaderPartners("x")).toEqual([]);
  });
  it("event logo: the light one on a light screen, else the base", () => {
    const b = { eventLogoUrl: "/sponsors/cairo-2026/white/davis-cup-event.png", eventLogoLightUrl: "/sponsors/cairo-2026/dark/davis-cup-event.png" };
    expect(eventLogoFor(b, "light")).toBe(b.eventLogoLightUrl);
    expect(eventLogoFor(b, "dark")).toBe(b.eventLogoUrl);
    expect(eventLogoFor({ eventLogoUrl: b.eventLogoUrl }, "light")).toBe(b.eventLogoUrl);
    expect(eventLogoFor({ eventLogoUrl: "javascript:x" }, "dark")).toBeNull();
  });
});

describe("breaks from recorded data only", () => {
  const live = play(initialScoreState("A"), "A", "A", "A", "A", "B", "B", "B", "B", "A", "A", "A", "A"); // 2-1
  it("a recorded changeover: 90 s from the console's start", () => {
    const s = startClock(live, "changeover", iso(T0));
    const b = breakScene(s, iso(T0 - 1000), T0 + 5_000, { shotClock: true });
    expect(b).toMatchObject({ kind: "changeover", total: 90, elapsedMs: 5_000 });
    expect(countdown(b!.total!, b!.elapsedMs).text).toBe("1:25");
  });
  it("set break, warm-up and medical (with whose)", () => {
    expect(breakScene(startClock(live, "set_break", iso(T0)), null, T0, { shotClock: false })?.kind).toBe("set_break");
    expect(breakScene(startClock(initialScoreState("A"), "warmup", iso(T0)), null, T0 + 1000, { shotClock: false })).toMatchObject({ kind: "warmup", total: 300 });
    expect(breakScene(startClock(live, "medical", iso(T0), "B"), null, T0, { shotClock: false })).toMatchObject({ kind: "medical", total: 180, team: "B" });
    expect(breakScene(startClock(live, "bathroom", iso(T0), "A"), null, T0, { shotClock: false })).toMatchObject({ kind: "other", label: "Bathroom break" });
  });
  it("a timer whose score moved on is over", () => {
    const s = play(startClock(live, "changeover", iso(T0)), "A");
    expect(s.clock).toBeUndefined();
    expect(breakScene(s, null, T0 + 1000, { shotClock: false })).toBeNull();
  });
  it("shot clock: 25 s from the score's last move, only when the organiser runs it", () => {
    const s = play(live, "A");
    expect(breakScene(s, iso(T0), T0 + 10_000, { shotClock: true })).toMatchObject({ kind: "shot", total: 25 });
    expect(breakScene(s, iso(T0), T0 + 25_000, { shotClock: true })).toBeNull();
    expect(breakScene(s, iso(T0), T0 + 10_000, { shotClock: false })).toBeNull();
    expect(breakScene(s, null, T0, { shotClock: true })).toBeNull();
  });
  it("no shot clock before the first point or after the match", () => {
    expect(breakScene(initialScoreState("A"), iso(T0), T0 + 1000, { shotClock: true })).toBeNull();
    expect(breakScene({ ...live, matchOver: true }, iso(T0), T0 + 1000, { shotClock: true })).toBeNull();
  });
});

describe("countdown", () => {
  it("counts down, then over time", () => {
    expect(countdown(25, 7_000, { seconds: true })).toMatchObject({ text: "18", remaining: 18, over: false });
    expect(countdown(120, 0)).toMatchObject({ text: "2:00", left: 1 });
    expect(countdown(300, 312_000)).toMatchObject({ text: "+0:12", over: true, left: 0, remaining: 0 });
    expect(countdown(90, 45_000).left).toBeCloseTo(0.5);
  });
});

describe("text", () => {
  it("legend lengths", () => {
    expect(OFFICIAL_BREAKS.map((b) => breakLength(b.seconds))).toEqual(["25 s", "90 s", "120 s", "5 min", "3 min"]);
  });
  it("changeover and set break lines", () => {
    const s = play(initialScoreState("A"), "A", "A", "A", "A", "B", "B", "B", "B", "A", "A", "A", "A");
    expect(changeoverWhat(s)).toBe("After game 3 · Set 1");
    expect(setBreakWhat([{ teamAGames: 6, teamBGames: 4 }], "Egypt", "Italy")).toBe("After set 1 · Egypt lead 6–4");
    expect(setBreakWhat([{ teamAGames: 6, teamBGames: 4 }, { teamAGames: 3, teamBGames: 6 }], "Egypt", "Italy")).toBe("After set 2 · Italy take it 6–3 · Sets level 1–1");
  });
  it("format, clock, score, names, stat cells", () => {
    expect(formatLine({ setsToWinMatch: 2 })).toBe("Best of 3 sets");
    expect(formatLine({ setsToWinMatch: 2, matchTiebreak: true, decidingPoint: true })).toBe("Best of 3 · match tie-break · No-ad");
    expect(matchClock(iso(T0), T0 + 78 * 60_000)).toBe("1:18");
    expect(matchClock(null, T0)).toBeNull();
    const sets = [{ teamAGames: 4, teamBGames: 6 }, { teamAGames: 7, teamBGames: 5 }, { teamAGames: 1, teamBGames: 0, matchTiebreak: true, tiebreak: { a: 10, b: 7 } }];
    expect(scoreFrom(sets, "A")).toBe("4–6 7–5 [10–7]");
    expect(scoreFrom(sets, "B")).toBe("6–4 5–7 [7–10]");
    expect(shortName("Kenzy Ahmad Abdalaziz")).toBe("K. A. Abdalaziz");
    expect(statCell("39/56 · 70%")).toEqual({ big: "70%", small: "39/56" });
    expect(statCell("3/7")).toEqual({ big: "3/7", small: null });
  });
  it("tie status", () => {
    expect(tieStatus([2, 0], "Egypt", "Italy", { rubbers: 3, decided: false })).toBe("Egypt win the tie · the last rubber is still played");
    expect(tieStatus([3, 0], "Egypt", "Italy", { rubbers: 3, decided: true })).toBe("Egypt win the tie 3–0");
    expect(tieStatus([1, 1], "Egypt", "Spain", { rubbers: 3, decided: false })).toBe("Tie level · the last rubber decides");
    expect(tieStatus([0, 1], "Egypt", "Spain", { rubbers: 3, decided: false })).toBe("Spain lead 1–0");
  });
});

describe("records at the event", () => {
  it("matches, sets and games per player across singles and doubles", () => {
    const r = eventRecords([
      { status: "completed", winner_team_id: "egy", team_a_id: "egy", a: ["g"], b: ["l"], sets: [{ teamAGames: 6, teamBGames: 4 }, { teamAGames: 6, teamBGames: 3 }] },
      { status: "completed", winner_team_id: "ita", team_a_id: "egy", a: ["g", "m"], b: ["l", "r"], sets: [{ teamAGames: 4, teamBGames: 6 }, { teamAGames: 6, teamBGames: 3 }, { teamAGames: 0, teamBGames: 1, matchTiebreak: true, tiebreak: { a: 8, b: 10 } }] },
      { status: "live", winner_team_id: null, team_a_id: "egy", a: ["g"], b: ["l"], sets: [] },
    ]);
    expect(r.g).toEqual({ matches: [1, 1], sets: [3, 2], games: [22, 17] });
    expect(r.l).toEqual({ matches: [1, 1], sets: [2, 3], games: [17, 22] });
    expect(r.m).toEqual({ matches: [0, 1], sets: [1, 2], games: [10, 10] });
  });
});

describe("the admin form", () => {
  const form = (entries: [string, string][]) => {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  };
  it("unticked switches are written as off", () => {
    const r = courtTvFromForm(form([["glass", "off"], ["break_animation", "off"], ["break_animation", "on"], ["break_timer", "off"], ["break_legend", "off"], ["post_match_stats", "off"], ["glass_opacity", "70"], ["palette", "noir"]]));
    expect(r.problems).toEqual([]);
    expect(r.settings).toEqual({ glass: false, glassOpacity: 70, breakAnimation: true, breakTimer: false, breakLegend: false, postMatchStats: false, palette: "noir" });
  });
  it("partners and the light logo: valid kept, invalid refused by name", () => {
    const ok = courtTvFromForm(form([
      ["event_logo_light_url", "/sponsors/cairo-2026/dark/bjk-cup-event.png"],
      ["partner_name_0", "ETF"], ["partner_logo_0", "/sponsors/cairo-2026/white/egyptian-tennis-federation-crest.png"], ["partner_light_0", "/sponsors/cairo-2026/dark/egyptian-tennis-federation-crest.png"], ["partner_aspect_0", "2.999"], ["partner_height_0", "57"],
      ["partner_name_1", ""], ["partner_logo_1", ""],
    ]));
    expect(ok.problems).toEqual([]);
    expect(ok.eventLogoLightUrl).toBe("/sponsors/cairo-2026/dark/bjk-cup-event.png");
    expect(ok.partners).toEqual([{ name: "ETF", logoUrl: "/sponsors/cairo-2026/white/egyptian-tennis-federation-crest.png", logoLightUrl: "/sponsors/cairo-2026/dark/egyptian-tennis-federation-crest.png", aspect: 2.999, height: 57 }]);
    const bad = courtTvFromForm(form([["event_logo_light_url", "http://x.png"], ["partner_name_2", "X"], ["partner_logo_2", "javascript:x"]]));
    expect(bad.problems).toHaveLength(2);
    expect(bad.partners).toEqual([]);
  });
});
