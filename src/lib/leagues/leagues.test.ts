import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAGUE_POINTS_RULES,
  applyLeagueMatch,
  diffLeaguePoints,
  leaguePoints,
  leaguePointsRules,
  leagueResultKind,
  reopenLeagueMatch,
  resultMonth,
  storedLeaguePointsRules,
  type LeaguePointsRules,
  type LeagueResult,
} from "./points";
import {
  boardEntriesFromPoints,
  boardLineOf,
  boardMonths,
  monthlyBoard,
  onPlatformScale,
  periodBoard,
  rankBoard,
  topOfAllLeagues,
  type BoardEntry,
  type BoardLeague,
} from "./boards";
import { joinDecision, normalizeInviteCode, normalizeJoinModes, statusAfterApproval, type JoinLeague } from "./join";

const TZ = "Africa/Cairo";
const STREAK: LeaguePointsRules = { ...DEFAULT_LEAGUE_POINTS_RULES, streak: { on: true, bonus: 1, from: 2, to: 3 } };

function res(matchId: string, profileId: string, kind: LeagueResult["kind"], date = "2026-10-01", endedAt?: string): LeagueResult {
  return { matchId, profileId, kind, date, ...(endedAt ? { endedAt } : {}) };
}

/* ------------------------------------------------------------------ */
/* points                                                              */
/* ------------------------------------------------------------------ */

describe("leaguePointsRules", () => {
  it("defaults to win 2, loss 1, streak off", () => {
    expect(leaguePointsRules(null)).toEqual(DEFAULT_LEAGUE_POINTS_RULES);
    expect(DEFAULT_LEAGUE_POINTS_RULES).toMatchObject({ win: 2, loss: 1, streak: { on: false } });
  });

  it("keeps edits, clamps junk, and round-trips the stored form", () => {
    const r = leaguePointsRules({ win: 3, loss: -4, walkover_win: 2.26, walkover_loss: "x", draw: 1, streak: { on: true, bonus: 2, from: 5, to: 3 } });
    expect(r).toEqual({ win: 3, draw: 1, loss: 0, walkoverWin: 2.5, walkoverLoss: 0, streak: { on: true, bonus: 2, from: 5, to: 5 } });
    expect(leaguePointsRules(storedLeaguePointsRules(r))).toEqual(r);
    expect(leaguePointsRules({ win: 1000 }).win).toBe(100);
  });
});

describe("leaguePoints", () => {
  it("scores wins and losses by the league's rules", () => {
    const { rows } = leaguePoints(DEFAULT_LEAGUE_POINTS_RULES, [res("m1", "p1", "win"), res("m1", "p2", "loss")], TZ);
    expect(rows.map((r) => [r.profileId, r.points, r.kind])).toEqual([
      ["p1", 2, "win"],
      ["p2", 1, "loss"],
    ]);
  });

  it("pays the streak bonus for wins `from`..`to` of a streak; a loss resets it", () => {
    const results = ["m1", "m2", "m3", "m4"].map((m, i) => res(m, "p", "win", `2026-10-0${i + 1}`));
    results.push(res("m5", "p", "loss", "2026-10-05"), res("m6", "p", "win", "2026-10-06"), res("m7", "p", "win", "2026-10-07"));
    const { rows, streaks } = leaguePoints(STREAK, results, TZ);
    expect(rows.map((r) => r.components.streak)).toEqual([0, 1, 1, 0, 0, 0, 1]);
    expect(rows.map((r) => r.points)).toEqual([2, 3, 3, 2, 1, 2, 3]);
    expect(streaks.get("p")).toBe(2);
  });

  it("freezes the streak on a walkover win and breaks it on a walkover loss, a draw or a played loss", () => {
    const rules = { ...STREAK, walkoverWin: 1, walkoverLoss: 0 };
    const { rows } = leaguePoints(
      rules,
      [
        res("m1", "p", "win", "2026-10-01"),
        res("m2", "p", "walkover_win", "2026-10-02"),
        res("m3", "p", "win", "2026-10-03"), // second win in a row: bonus
        res("m4", "p", "walkover_loss", "2026-10-04"),
        res("m5", "p", "win", "2026-10-05"),
        res("m6", "p", "draw", "2026-10-06"),
        res("m7", "p", "win", "2026-10-07"),
      ],
      TZ,
    );
    expect(rows.map((r) => [r.kind, r.points, r.streakAfter])).toEqual([
      ["win", 2, 1],
      ["walkover_win", 1, 1],
      ["win", 3, 2],
      ["walkover_loss", 0, 0],
      ["win", 2, 1],
      ["draw", 1.5, 0],
      ["win", 2, 1],
    ]);
  });

  it("leaves voids out and keeps the last of duplicate results (a correction)", () => {
    const { rows } = leaguePoints(DEFAULT_LEAGUE_POINTS_RULES, [res("m1", "p", "win"), res("m2", "p", "void"), res("m1", "p", "loss")], TZ);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ matchId: "m1", kind: "loss", points: 1 });
  });

  it("orders a night's matches by when they ended, then by match id", () => {
    const { rows } = leaguePoints(
      STREAK,
      [
        res("b", "p", "win", "2026-10-01", "2026-10-01T19:00:00Z"),
        res("a", "p", "loss", "2026-10-01", "2026-10-01T20:00:00Z"),
        res("c", "p", "win", "2026-10-01"),
      ],
      TZ,
    );
    expect(rows.map((r) => r.matchId)).toEqual(["b", "a", "c"]);
  });

  it("counts a result in its night's month in the league's zone", () => {
    expect(resultMonth("2026-10-31", TZ)).toBe("2026-10");
    // 22:30 UTC on 31 Oct is already 1 Nov in Cairo (UTC+2 after the October clock change).
    expect(resultMonth("2026-10-31T22:30:00Z", TZ)).toBe("2026-11");
    expect(resultMonth("2026-10-31T22:30:00Z", "UTC")).toBe("2026-10");
    expect(resultMonth("2026-10-31T22:30:00Z", "Not/AZone")).toBe("2026-11");
    const { rows } = leaguePoints(DEFAULT_LEAGUE_POINTS_RULES, [res("m1", "p", "win", "2026-10-31T22:30:00Z")], TZ);
    expect(rows[0].month).toBe("2026-11");
  });

  it("maps a match outcome to a result kind", () => {
    expect(leagueResultKind({ won: true, walkover: false })).toBe("win");
    expect(leagueResultKind({ won: false, walkover: true })).toBe("walkover_loss");
    expect(leagueResultKind({ won: false, walkover: false, draw: true })).toBe("draw");
    expect(leagueResultKind({ won: true, walkover: false, void: true })).toBe("void");
  });
});

describe("undo and corrections", () => {
  const results = [
    res("m1", "p", "win", "2026-10-01"),
    res("m1", "q", "loss", "2026-10-01"),
    res("m2", "p", "win", "2026-10-02"),
    res("m2", "q", "loss", "2026-10-02"),
    res("m3", "p", "win", "2026-10-03"),
  ];

  it("reopening a match removes its rows and re-evaluates later bonuses", () => {
    const stored = leaguePoints(STREAK, results, TZ).rows;
    expect(stored.filter((r) => r.profileId === "p").map((r) => r.points)).toEqual([2, 3, 3]);
    const change = reopenLeagueMatch(STREAK, results, stored, "m1", TZ);
    expect(change.remove).toEqual([
      { matchId: "m1", profileId: "p" },
      { matchId: "m1", profileId: "q" },
    ]);
    // m2 is now p's first win in a row (no bonus); m3 the second (bonus kept, streak now 2).
    expect(change.upsert.map((r) => [r.matchId, r.profileId, r.points, r.streakAfter])).toEqual([
      ["m2", "p", 2, 1],
      ["m3", "p", 3, 2],
    ]);
  });

  it("applying an unchanged result touches nothing, a new one only its rows", () => {
    const stored = leaguePoints(STREAK, results, TZ).rows;
    expect(applyLeagueMatch(STREAK, results, stored, TZ)).toEqual({ remove: [], upsert: [] });
    const more = [...results, res("m4", "q", "win", "2026-10-04")];
    const change = applyLeagueMatch(STREAK, more, stored, TZ);
    expect(change.remove).toEqual([]);
    expect(change.upsert.map((r) => r.matchId)).toEqual(["m4"]);
  });

  it("diff removes rows that are no longer wanted", () => {
    const stored = leaguePoints(STREAK, results, TZ).rows;
    expect(diffLeaguePoints(stored, []).remove).toHaveLength(stored.length);
  });
});

/* ------------------------------------------------------------------ */
/* boards                                                              */
/* ------------------------------------------------------------------ */

function e(profileId: string, month: string, points: number, extra: Partial<BoardEntry> = {}): BoardEntry {
  return { profileId, month, points, ...extra };
}

describe("boards", () => {
  it("ranks by points, wins, game difference, games won; full ties share a rank", () => {
    const board = rankBoard([
      e("a", "2026-10", 6, { wins: 3 }),
      e("b", "2026-10", 6, { wins: 2, gamesWon: 20, gamesLost: 10 }),
      e("c", "2026-10", 6, { wins: 2, gamesWon: 18, gamesLost: 8 }),
      e("d", "2026-10", 6, { wins: 2, gamesWon: 20, gamesLost: 10 }),
      e("e", "2026-10", 9),
      e("e", "2026-10", -1),
    ]);
    expect(board.map((l) => [l.profileId, l.rank])).toEqual([
      ["e", 1],
      ["a", 2],
      ["b", 3],
      ["d", 3],
      ["c", 5],
    ]);
    expect(boardLineOf(board, "e")?.points).toBe(8);
    expect(boardLineOf(board, "zz")).toBeNull();
  });

  it("builds entries from points rows", () => {
    const { rows } = leaguePoints(DEFAULT_LEAGUE_POINTS_RULES, [res("m1", "p", "win"), res("m1", "q", "loss")], TZ);
    const entries = boardEntriesFromPoints(rows, new Map([["m1|p", { won: 6, lost: 3 }]]));
    expect(entries[0]).toMatchObject({ profileId: "p", wins: 1, losses: 0, gamesWon: 6, gamesLost: 3, played: 1, month: "2026-10" });
    expect(entries[1]).toMatchObject({ profileId: "q", wins: 0, losses: 1, gamesWon: 0 });
  });

  it("computes the months of 3/6/9/12-month boards from the year start", () => {
    expect(boardMonths("2026-10", 1)).toEqual(["2026-10"]);
    expect(boardMonths("2026-10", 3)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(boardMonths("2026-10", 3, 9)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(boardMonths("2027-01", 3, 9)).toEqual(["2026-12", "2027-01", "2027-02"]);
    expect(boardMonths("2027-02", 6, 9)).toEqual(["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(boardMonths("2027-08", 12, 9)).toHaveLength(12);
    expect(boardMonths("2027-08", 12, 9)[0]).toBe("2026-09");
    expect(boardMonths("2027-05", 9, 9)).toEqual(boardMonths("2026-09", 9, 9));
    expect(boardMonths("2027-06", 9, 9)).toEqual(["2027-06", "2027-07", "2027-08"]);
    expect(boardMonths("2026-02", 3, 1, "rolling")).toEqual(["2025-12", "2026-01", "2026-02"]);
    expect(boardMonths("junk", 3)).toEqual([]);
  });

  it("monthly boards reset; period boards sum months", () => {
    const entries = [e("a", "2026-09", 10), e("b", "2026-10", 4), e("a", "2026-10", 1), e("b", "2026-11", 4)];
    expect(monthlyBoard(entries, "2026-10").map((l) => [l.profileId, l.points])).toEqual([
      ["b", 4],
      ["a", 1],
    ]);
    expect(periodBoard(entries, "2026-10", 3, 9).map((l) => [l.profileId, l.points])).toEqual([
      ["a", 11],
      ["b", 8],
    ]);
    expect(periodBoard(entries, "2026-10", 3, 10).map((l) => [l.profileId, l.points])).toEqual([
      ["b", 8],
      ["a", 1],
    ]);
  });

  it("top of all leagues: per organisation, and platform-wide without opted-out organisations", () => {
    const leagues: BoardLeague[] = [
      { id: "L1", organizationId: "org1", countsTowardTopOfAll: true },
      { id: "L2", organizationId: "org1", countsTowardTopOfAll: false },
      { id: "L3", organizationId: "org2", countsTowardTopOfAll: true },
    ];
    const entries = [
      e("a", "2026-10", 5, { leagueId: "L1" }),
      e("a", "2026-10", 50, { leagueId: "L2" }),
      e("b", "2026-10", 7, { leagueId: "L3" }),
      e("a", "2026-10", 4, { leagueId: "L3" }),
      e("c", "2026-10", 99), // no league
      e("b", "2026-09", 99, { leagueId: "L3" }),
    ];
    const org1 = topOfAllLeagues(entries, leagues, { kind: "organization", organizationId: "org1" }, "2026-10");
    expect(org1.map((l) => [l.profileId, l.points])).toEqual([["a", 5]]);
    // The platform board has its own scale: an entry without a result kind is capped at a default win (2).
    const platform = topOfAllLeagues(entries, leagues, { kind: "platform", optedOut: [] }, "2026-10");
    expect(platform.map((l) => [l.profileId, l.points])).toEqual([
      ["a", 4],
      ["b", 2],
    ]);
    const without2 = topOfAllLeagues(entries, leagues, { kind: "platform", optedOut: new Set(["org2"]) }, "2026-10");
    expect(without2.map((l) => [l.profileId, l.points])).toEqual([["a", 2]]);
  });

  it("L5: the platform board scores results on the platform's scale, so a league's own scale cannot dominate it", () => {
    const leagues: BoardLeague[] = [
      { id: "BIG", organizationId: "org1", countsTowardTopOfAll: true },
      { id: "STD", organizationId: "org2", countsTowardTopOfAll: true },
    ];
    // BIG gives 100 a win; STD the defaults (win 2, loss 1).
    const entries: BoardEntry[] = [
      { profileId: "big", month: "2026-10", points: 100, wins: 1, played: 1, leagueId: "BIG", kind: "win" },
      { profileId: "std", month: "2026-10", points: 2, wins: 1, played: 1, leagueId: "STD", kind: "win" },
      { profileId: "std", month: "2026-10", points: 2, wins: 1, played: 1, leagueId: "STD", kind: "win" },
      { profileId: "std", month: "2026-10", points: 1, losses: 1, played: 1, leagueId: "STD", kind: "loss" },
    ];
    const platform = topOfAllLeagues(entries, leagues, { kind: "platform", optedOut: [] }, "2026-10");
    expect(platform.map((l) => [l.profileId, l.points])).toEqual([
      ["std", 5],
      ["big", 2],
    ]);
    // The organisation's own board keeps its own points.
    const own = topOfAllLeagues(entries, leagues, { kind: "organization", organizationId: "org1" }, "2026-10");
    expect(own.map((l) => [l.profileId, l.points])).toEqual([["big", 100]]);
    expect(onPlatformScale({ profileId: "x", month: "2026-10", points: 100, kind: "walkover_win" }).points).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* join                                                                */
/* ------------------------------------------------------------------ */

const FEE = { amount: 500, currency: "EGP" };
const league = (over: Partial<JoinLeague>): JoinLeague => ({ joinModes: ["open"], paymentsEnabled: true, ...over });

describe("join", () => {
  it("cleans stored modes", () => {
    expect(normalizeJoinModes(["open"])).toEqual(["open"]);
    expect(normalizeJoinModes(["paid", "open", "approval", "paid", "bogus"])).toEqual(["approval", "paid"]);
    expect(normalizeJoinModes("invite_code")).toEqual(["invite_code"]);
    expect(normalizeJoinModes(null)).toEqual([]);
    expect(normalizeInviteCode(" mb-7k2 q ")).toBe("MB7K2Q");
  });

  it("open joins at once; closed or modeless leagues refuse", () => {
    expect(joinDecision(league({}), { signedIn: true })).toEqual({ outcome: "join", payAtVenue: false });
    expect(joinDecision(league({}), { signedIn: false })).toEqual({ outcome: "refused", reason: "sign_in" });
    expect(joinDecision(league({ closed: true }), { signedIn: true })).toEqual({ outcome: "refused", reason: "closed" });
    expect(joinDecision(league({ joinModes: [] }), { signedIn: true })).toEqual({ outcome: "refused", reason: "closed" });
  });

  it("refuses members, pending requests and removed players", () => {
    expect(joinDecision(league({}), { signedIn: true, membership: "active" })).toMatchObject({ reason: "already_member" });
    expect(joinDecision(league({}), { signedIn: true, membership: "pending" })).toMatchObject({ reason: "already_pending" });
    expect(joinDecision(league({}), { signedIn: true, membership: "removed" })).toMatchObject({ reason: "removed" });
  });

  it("checks the invite code first", () => {
    const l = league({ joinModes: ["invite_code", "approval"] });
    expect(joinDecision(l, { signedIn: true })).toMatchObject({ reason: "invite_code_required" });
    expect(joinDecision(l, { signedIn: true, inviteCode: { valid: false } })).toMatchObject({ reason: "invite_code_wrong" });
    expect(joinDecision(l, { signedIn: true, inviteCode: { valid: true } })).toEqual({ outcome: "pending_approval", thenPayment: false, payAtVenue: false });
    expect(joinDecision(league({ joinModes: ["invite_code"] }), { signedIn: true, inviteCode: { valid: true } })).toMatchObject({ outcome: "join" });
  });

  it("asks for payment through Move Tick, after approval when both apply", () => {
    const paid = league({ joinModes: ["paid"], membershipFee: FEE });
    expect(joinDecision(paid, { signedIn: true })).toEqual({ outcome: "payment_required", amount: 500, currency: "EGP" });
    expect(joinDecision(paid, { signedIn: true, paid: true })).toEqual({ outcome: "join", payAtVenue: false });
    const both = league({ joinModes: ["paid", "approval"], membershipFee: FEE });
    expect(joinDecision(both, { signedIn: true })).toEqual({ outcome: "pending_approval", thenPayment: true, payAtVenue: false });
    expect(statusAfterApproval(both)).toBe("awaiting_payment");
    expect(joinDecision(both, { signedIn: true, membership: "awaiting_payment" })).toMatchObject({ outcome: "payment_required" });
    expect(joinDecision(both, { signedIn: true, membership: "awaiting_payment", paid: true })).toEqual({ outcome: "join", payAtVenue: false });
    expect(statusAfterApproval(league({ joinModes: ["approval"] }))).toBe("active");
  });

  it("pays at the venue where online payment is not available, and ignores a zero fee", () => {
    const venue = league({ joinModes: ["paid"], membershipFee: FEE, paymentsEnabled: false });
    expect(joinDecision(venue, { signedIn: true })).toEqual({ outcome: "join", payAtVenue: true });
    expect(statusAfterApproval(venue)).toBe("active");
    expect(joinDecision(league({ joinModes: ["paid"], membershipFee: { amount: 0, currency: "EGP" } }), { signedIn: true })).toEqual({
      outcome: "join",
      payAtVenue: false,
    });
  });
});
