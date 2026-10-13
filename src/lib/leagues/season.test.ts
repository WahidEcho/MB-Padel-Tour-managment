import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pairingKey, roundDate, seasonEntrants, seasonPlan } from "./fixtures";
import { leagueResultsOfMatch, sideGames } from "./results";
import { leaguePoints } from "./points";
import {
  addDays,
  DEFAULT_NIGHT_TEMPLATE,
  isIsoDate,
  leagueFee,
  leaguePeriods,
  leagueSlug,
  monthLabel,
  nightTemplate,
  shiftMonth,
  storedLeaguePeriods,
  storedNightTemplate,
} from "./settings";
import { formatLeagueInviteCode, generateLeagueInviteCode, hashLeagueInviteCode, leagueInviteCodeMatches } from "./inviteCode";

describe("league settings", () => {
  it("periods keep the monthly board and known lengths only", () => {
    expect(leaguePeriods(null)).toEqual({ monthly: true, boards: [1, 3, 12], yearStartMonth: 1 });
    expect(leaguePeriods({ boards: [12, 5, "6", 3], year_start_month: 9 })).toEqual({ monthly: true, boards: [1, 3, 6, 12], yearStartMonth: 9 });
    expect(leaguePeriods({ boards: [], year_start_month: 40 }).yearStartMonth).toBe(12);
    expect(leaguePeriods(storedLeaguePeriods(leaguePeriods({ boards: [9], year_start_month: 4 })))).toEqual({ monthly: true, boards: [1, 9], yearStartMonth: 4 });
  });

  it("fees need a positive amount and a currency", () => {
    expect(leagueFee({ membership: { amount: 500, currency: "egp" }, per_night: { amount: 0 } })).toEqual({ membership: { amount: 500, currency: "EGP" }, perNight: null });
    expect(leagueFee({ perNight: { amount: 150.4, currency: "x" } }).perNight).toEqual({ amount: 150, currency: "EGP" });
    expect(leagueFee("junk")).toEqual({ membership: null, perNight: null });
  });

  it("the night template falls back field by field and round-trips", () => {
    expect(nightTemplate(undefined)).toEqual(DEFAULT_NIGHT_TEMPLATE);
    const t = nightTemplate({ start_time: "20:30", courts: 50, pairing_mode: "mexicano", sets_to_win_match: 2, max_players: "16", scoring_mode: "nope" });
    expect(t).toMatchObject({ startTime: "20:30", courts: 20, pairingMode: "mexicano", setsToWinMatch: 2, maxPlayers: 16, scoringMode: "either" });
    expect(nightTemplate(storedNightTemplate(t))).toEqual(t);
    expect(nightTemplate({ start_time: "25:00" }).startTime).toBe("19:00");
  });

  it("dates and months", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(addDays("2026-12-29", 7)).toBe("2027-01-05");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-11", 3)).toBe("2027-02");
    expect(monthLabel("2026-11")).toBe("November 2026");
    expect(leagueSlug("Tuesday Padel League!", "AB12x")).toBe("tuesday-padel-league-ab12x");
  });
});

describe("season fixtures", () => {
  const m = (id: string, profileId: string, partnerProfileId: string | null = null) => ({ id, profileId, partnerProfileId });

  it("members become entrants; mutual partners are one pair", () => {
    const e = seasonEntrants([m("m1", "p1", "p2"), m("m2", "p2", "p1"), m("m3", "p3"), m("m4", "p4", "p9")]);
    expect(e).toEqual([
      { memberId: "m1", profiles: ["p1", "p2"] },
      { memberId: "m3", profiles: ["p3"] },
      { memberId: "m4", profiles: ["p4", "p9"] },
    ]);
  });

  it("a full round robin, one round per date, then weekly", () => {
    const entrants = seasonEntrants(["a", "b", "c", "d"].map((x) => m(`m-${x}`, `p-${x}`)));
    const plan = seasonPlan(entrants, ["2026-11-03", "2026-11-10"]);
    expect(plan).toHaveLength(6);
    const keys = new Set(plan.map((p) => pairingKey(p.home.memberId, p.away.memberId)));
    expect(keys.size).toBe(6);
    expect([...new Set(plan.map((p) => p.round))]).toEqual([1, 2, 3]);
    expect(plan.filter((p) => p.round === 3).every((p) => p.date === "2026-11-17")).toBe(true);
    expect(plan.filter((p) => p.round === 1).every((p) => p.date === "2026-11-03")).toBe(true);
    expect(roundDate([], 2, "2026-01-01")).toBe("2026-01-08");
  });

  it("an odd count rests one entrant per round", () => {
    const entrants = seasonEntrants(["a", "b", "c"].map((x) => m(`m-${x}`, `p-${x}`)));
    const plan = seasonPlan(entrants, ["2026-11-03"]);
    expect(plan).toHaveLength(3);
    expect(new Set(plan.map((p) => p.round)).size).toBe(3);
  });

  it("regeneration skips played pairings, adds a late member and renumbers from the next round", () => {
    const four = seasonEntrants(["a", "b", "c", "d"].map((x) => m(`m-${x}`, `p-${x}`)));
    const first = seasonPlan(four, ["2026-11-03"]);
    const played = new Set(first.filter((p) => p.round === 1).map((p) => pairingKey(p.home.memberId, p.away.memberId)));
    const five = seasonEntrants(["a", "b", "c", "d", "e"].map((x) => m(`m-${x}`, `p-${x}`)));
    const again = seasonPlan(five, ["2026-12-01"], { skip: played, firstRound: 2 });
    expect(again).toHaveLength(10 - played.size);
    expect(again.some((p) => played.has(pairingKey(p.home.memberId, p.away.memberId)))).toBe(false);
    expect(again.some((p) => p.home.memberId === "m-e" || p.away.memberId === "m-e")).toBe(true);
    expect(Math.min(...again.map((p) => p.round))).toBe(2);
    expect(again.filter((p) => p.round === 2).every((p) => p.date === "2026-12-01")).toBe(true);
  });
});

describe("league results of a match", () => {
  const base = { id: "x", team_a_id: "A", team_b_id: "B", ended_at: "2026-10-31T22:30:00Z" };

  it("a win and a loss for each side, with games", () => {
    const r = leagueResultsOfMatch({ ...base, status: "completed", winner_team_id: "A" }, { a: ["p1", "p2"], b: ["p3", null] }, "2026-10-31", {
      completed_sets: [{ teamAGames: 6, teamBGames: 4 }, { teamAGames: 6, teamBGames: 3 }],
      team_a_games: 6,
      team_b_games: 3,
    });
    expect(r.results.map((x) => [x.profileId, x.kind])).toEqual([["p1", "win"], ["p2", "win"], ["p3", "loss"]]);
    expect(r.games.get("x|p1")).toEqual({ won: 12, lost: 7 });
    expect(r.games.get("x|p3")).toEqual({ won: 7, lost: 12 });
  });

  it("walkovers, draws, unfinished and a player on both sides", () => {
    expect(leagueResultsOfMatch({ ...base, status: "walkover", winner_team_id: "B" }, { a: ["p1"], b: ["p2"] }, "2026-10-31").results.map((x) => x.kind)).toEqual(["walkover_loss", "walkover_win"]);
    expect(leagueResultsOfMatch({ ...base, status: "completed", winner_team_id: null }, { a: ["p1"], b: ["p2"] }, "2026-10-31").results.map((x) => x.kind)).toEqual(["draw", "draw"]);
    expect(leagueResultsOfMatch({ ...base, status: "live", winner_team_id: null }, { a: ["p1"], b: ["p2"] }, "2026-10-31").results).toEqual([]);
    expect(leagueResultsOfMatch({ ...base, status: "completed", winner_team_id: "A" }, { a: ["p1", "p9"], b: ["p9", "p2"] }, "2026-10-31").results.map((x) => x.profileId)).toEqual(["p1", "p2"]);
  });

  it("the month is the night's date, not the instant it ended (time-zone edge)", () => {
    // Ended 01:30 on 1 November in Cairo; the night was 31 October.
    const r = leagueResultsOfMatch({ ...base, status: "completed", winner_team_id: "A" }, { a: ["p1"], b: ["p2"] }, "2026-10-31");
    expect(leaguePoints(undefined, r.results, "Africa/Cairo").rows.map((x) => x.month)).toEqual(["2026-10", "2026-10"]);
  });

  it("side games count an unfinished last set once", () => {
    expect(sideGames({ completed_sets: [{ teamAGames: 6, teamBGames: 2 }], team_a_games: 6, team_b_games: 2 })).toEqual({ a: 6, b: 2 });
    expect(sideGames({ completed_sets: [{ teamAGames: 6, teamBGames: 2 }], team_a_games: 3, team_b_games: 1 })).toEqual({ a: 9, b: 3 });
    expect(sideGames(null)).toEqual({ a: 0, b: 0 });
  });
});

describe("league invite codes", () => {
  const pepper = "p".repeat(40);
  it("are 8 symbols, stored only as a peppered hash, compared case- and dash-blind", () => {
    const code = generateLeagueInviteCode();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    const hash = hashLeagueInviteCode(code, pepper)!;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(code.toLowerCase());
    expect(leagueInviteCodeMatches(formatLeagueInviteCode(code).toLowerCase(), hash, pepper)).toBe(true);
    expect(leagueInviteCodeMatches("AAAA-AAAA", hash, pepper)).toBe(false);
    expect(leagueInviteCodeMatches(code, null, pepper)).toBe(false);
    expect(hashLeagueInviteCode("short", pepper)).toBeNull();
    // Domain-separated from event codes: the same characters never hash alike.
    expect(hashLeagueInviteCode(code, "q".repeat(40))).not.toBe(hash);
  });
});

describe("league server code never leaks private player fields", () => {
  const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
  for (const file of ["server.ts", "ops.ts"]) {
    it(`${file} selects explicit, public player columns only`, () => {
      const src = read(file);
      for (const m of src.matchAll(/\.from\("(players|player_profiles)"\)\.select\("([^"]*)"\)/g)) {
        expect(m[2], `${file}: ${m[1]} columns`).not.toMatch(/\*|phone|email|access_code|mobile|birth|photo|portrait/);
      }
      // The invite-code hash is read in one place only (joinLeague), never with the league row.
      expect(src.match(/select\("[^"]*invite_code_hash/g)?.length ?? 0).toBe(file === "server.ts" ? 1 : 0);
    });
  }
  it("the public league columns leave the invite-code hash out", () => {
    expect(read("server.ts")).toMatch(/LEAGUE_COLUMNS =\s*\n?\s*"[^"]*"/);
    const cols = /LEAGUE_COLUMNS =\s*\n?\s*"([^"]*)"/.exec(read("server.ts"))![1];
    expect(cols).not.toMatch(/invite_code_hash/);
  });
  it("joining resolves the account's own profile before writing a member row", () => {
    const src = read("server.ts");
    const fn = src.slice(src.indexOf("export async function joinLeague"));
    expect(fn.indexOf("profileForUser(")).toBeGreaterThan(-1);
    expect(fn.indexOf("profileForUser(")).toBeLessThan(fn.indexOf('from("league_members").insert'));
  });
});
