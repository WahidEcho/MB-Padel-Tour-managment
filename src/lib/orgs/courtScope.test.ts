import { describe, expect, it } from "vitest";
import { signStaffToken, verifyStaffToken } from "../auth/staffToken";
import { CARRY_GRACE_MINUTES, carryStillReaches, courtEarlierDays, courtDayList, courtIdsNamed, courtKey, courtLink, courtListSection, courtReachesMatch, parseCourtLink, physicalCourts, type CourtScope } from "./courtScope";
import { isScopedCode, principalReaches } from "./scope";
import { formatEventCode, generateEventCode, openEventCode, sealEventCode } from "./codes";

process.env.AUTH_SECRET ??= "test-auth-secret-for-vitest-only-0123456789";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BOYS = "55555555-5555-4555-8555-555555555555";
const GIRLS = "66666666-6666-4666-8666-666666666666";
const ELSEWHERE = "77777777-7777-4777-8777-777777777777";
const C1_BOYS = "a1111111-1111-4111-8111-111111111111";
const C1_GIRLS = "a2222222-2222-4222-8222-222222222222";
const C2_BOYS = "b1111111-1111-4111-8111-111111111111";

const court1: CourtScope = { name: "Court 1", key: "court 1", eventGroupId: "g", tournamentIds: [BOYS, GIRLS], courtIds: [C1_BOYS, C1_GIRLS], withCourt: [BOYS, GIRLS] };
const referee = { orgId: ORG, scopeTournamentId: null, scopeCourt: court1 };

describe("court names", () => {
  it("compare case- and space-insensitively", () => {
    expect(courtKey("  Court   1 ")).toBe("court 1");
    expect(courtKey("COURT 1")).toBe(courtKey("court 1"));
    expect(courtKey("Court 1")).not.toBe(courtKey("Court 10"));
  });
  it("one physical court across the events of a group", () => {
    const rows = [
      { id: C1_BOYS, tournament_id: BOYS, court_name: "Court 1", court_order: 1 },
      { id: C2_BOYS, tournament_id: BOYS, court_name: "Court 2", court_order: 2 },
      { id: C1_GIRLS, tournament_id: GIRLS, court_name: "court 1 ", court_order: 1 },
      { id: "x", tournament_id: BOYS, court_name: "Court 10", court_order: 3 },
      { id: "y", tournament_id: ELSEWHERE, court_name: "Court 1", court_order: 1 },
    ];
    expect(courtIdsNamed(rows, [BOYS, GIRLS], "Court 1").sort()).toEqual([C1_BOYS, C1_GIRLS].sort());
    const phys = physicalCourts(rows.filter((r) => r.tournament_id !== ELSEWHERE));
    expect(phys.map((p) => p.name)).toEqual(["Court 1", "Court 2", "Court 10"]);
    expect(phys[0].tournamentIds.sort()).toEqual([BOYS, GIRLS].sort());
  });
});

describe("what a court code reaches", () => {
  it("a match on its court, in either event of the group", () => {
    expect(principalReaches(referee, { orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "match", courtId: C1_BOYS })).toBe(true);
    expect(principalReaches(referee, { orgId: ORG, tournamentId: GIRLS, kind: "tournament", ref: "match", courtId: C1_GIRLS })).toBe(true);
  });
  it("never another court's match, a match with no court, or another event's Court 1", () => {
    expect(principalReaches(referee, { orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "match", courtId: C2_BOYS })).toBe(false);
    expect(principalReaches(referee, { orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "match", courtId: null })).toBe(false);
    expect(principalReaches(referee, { orgId: ORG, tournamentId: ELSEWHERE, kind: "tournament", ref: "match", courtId: C1_BOYS })).toBe(false);
    expect(courtReachesMatch(court1, { tournamentId: BOYS, courtId: undefined })).toBe(false);
  });
  it("its tournaments themselves (the lists), nothing else of theirs, nothing of another organisation", () => {
    expect(principalReaches(referee, { orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "tournament" })).toBe(true);
    expect(principalReaches(referee, { orgId: ORG, tournamentId: BOYS, kind: "tournament" })).toBe(false);
    expect(principalReaches(referee, { orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "other" })).toBe(false);
    expect(principalReaches(referee, { orgId: OTHER, tournamentId: BOYS, kind: "tournament", ref: "match", courtId: C1_BOYS })).toBe(false);
    expect(principalReaches(referee, null)).toBe(false);
  });
  it("a one-tournament court code also keeps its tournament scope", () => {
    const one = { orgId: ORG, scopeTournamentId: BOYS, scopeCourt: { ...court1, eventGroupId: null, tournamentIds: [BOYS], courtIds: [C1_BOYS], withCourt: [BOYS] } };
    expect(principalReaches(one, { orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "match", courtId: C1_BOYS })).toBe(true);
    expect(principalReaches(one, { orgId: ORG, tournamentId: GIRLS, kind: "tournament", ref: "match", courtId: C1_GIRLS })).toBe(false);
  });
  it("is a scoped code (no organisation-level work)", () => {
    expect(isScopedCode(referee)).toBe(true);
    expect(isScopedCode({ scopeTournamentId: null, scopeCourt: null })).toBe(false);
    expect(isScopedCode({ scopeTournamentId: BOYS })).toBe(true);
  });
  it("members and unscoped codes are unchanged", () => {
    expect(principalReaches({ orgId: ORG, scopeTournamentId: null }, { orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "match", courtId: C2_BOYS })).toBe(true);
  });
});

describe("today's list on a court (Cairo day)", () => {
  // 2 Nov 2026, 14:00 in Cairo (UTC+2).
  const now = Date.parse("2026-11-02T12:00:00Z");
  const tz = "Africa/Cairo";
  const m = (id: string, status: string, scheduled: string | null, extra: Record<string, unknown> = {}) => ({ id, status, scheduled_time: scheduled, court_id: C1_BOYS, match_order: 1, ...extra });
  it("live always; upcoming today, overdue and untimed; finished today only; never tomorrow or cancelled", () => {
    expect(courtListSection(m("a", "live", "2026-11-01T08:00:00Z"), tz, now)).toBe("live");
    expect(courtListSection(m("b", "scheduled", "2026-11-02T15:00:00Z"), tz, now)).toBe("upcoming");
    expect(courtListSection(m("c", "scheduled", "2026-11-03T07:00:00Z"), tz, now)).toBeNull();
    expect(courtListSection(m("d", "scheduled", "2026-11-01T07:00:00Z"), tz, now)).toBe("upcoming");
    expect(courtListSection(m("e", "scheduled", null), tz, now)).toBe("upcoming");
    expect(courtListSection(m("f", "completed", "2026-11-02T07:00:00Z", { ended_at: "2026-11-02T09:00:00Z" }), tz, now)).toBe("finished");
    expect(courtListSection(m("g", "completed", "2026-11-01T07:00:00Z", { ended_at: "2026-11-01T09:00:00Z" }), tz, now)).toBeNull();
    expect(courtListSection(m("h", "cancelled", "2026-11-02T15:00:00Z"), tz, now)).toBeNull();
    expect(courtListSection(m("i", "ready", "2026-11-03T07:00:00Z"), tz, now)).toBe("upcoming");
  });
  it("counts the day in Cairo, not UTC (23:30 UTC on 1 Nov is 2 Nov in Cairo)", () => {
    expect(courtListSection(m("j", "scheduled", "2026-11-01T23:30:00Z"), tz, now)).toBe("upcoming");
    expect(courtListSection(m("k", "scheduled", "2026-11-02T22:30:00Z"), tz, now)).toBeNull();
  });
  it("orders upcoming by time, untimed last", () => {
    const d = courtDayList([m("late", "scheduled", "2026-11-02T15:00:00Z"), m("none", "scheduled", null), m("early", "scheduled", "2026-11-02T08:00:00Z")], tz, now);
    expect(d.upcoming.map((x) => x.id)).toEqual(["early", "late", "none"]);
  });
});

describe("the court QR", () => {
  it("carries the code in the #fragment of a link on the public site, and reads back", () => {
    const code = formatEventCode(generateEventCode());
    const url = courtLink("https://tour.mbeg.org/", code);
    expect(url).toBe(`https://tour.mbeg.org/r#${code}`);
    expect(new URL(url).pathname).toBe("/r");
    expect(parseCourtLink(url)).toBe(code);
    expect(parseCourtLink(`movescore://r#${code}`)).toBe(code);
    for (const bad of ["https://tour.mbeg.org/r", "https://tour.mbeg.org/m/abc", `https://tour.mbeg.org/r/${code}`, "hello", ""]) expect(parseCourtLink(bad)).toBeNull();
  });
  it("court codes are sealed for reprinting and open only with the same pepper", () => {
    const code = generateEventCode();
    const sealed = sealEventCode(code, "p".repeat(40));
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(code);
    expect(openEventCode(sealed, "p".repeat(40))).toBe(code);
    expect(openEventCode(sealed, "q".repeat(40))).toBeNull();
    expect(openEventCode("v1.x.y.z", "p".repeat(40))).toBeNull();
  });
});

describe("switching courts: the carry-over credential", () => {
  const M1 = "c1111111-1111-4111-8111-111111111111";
  const M2 = "c2222222-2222-4222-8222-222222222222";
  const carry = { ...referee, scopeMatchIds: [M1] };
  const now = Date.parse("2026-11-02T12:00:00Z");
  const match = (id: string, status = "live", endedAt: string | null = null) => ({ orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "match" as const, courtId: C1_BOYS, matchId: id, matchStatus: status, matchEndedAt: endedAt });
  it("reaches only its listed matches, never a new one, and nothing but matches", () => {
    expect(principalReaches(carry, match(M1), now)).toBe(true);
    expect(principalReaches(carry, match(M2), now)).toBe(false);
    expect(principalReaches(carry, { orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "tournament" }, now)).toBe(false);
    expect(isScopedCode({ scopeTournamentId: null, scopeMatchIds: [M1] })).toBe(true);
  });
  it("lapses on its own once the match is finished (after the grace) or cancelled", () => {
    const ended = new Date(now - (CARRY_GRACE_MINUTES - 1) * 60_000).toISOString();
    const long = new Date(now - (CARRY_GRACE_MINUTES + 1) * 60_000).toISOString();
    expect(principalReaches(carry, match(M1, "completed", ended), now)).toBe(true);
    expect(principalReaches(carry, match(M1, "completed", long), now)).toBe(false);
    expect(carryStillReaches({ status: "cancelled" }, now)).toBe(false);
    expect(carryStillReaches({ status: "paused" }, now)).toBe(true);
  });
  it("still needs the old court: a carried match moved off the court is out of reach", () => {
    expect(principalReaches(carry, { ...match(M1), courtId: C2_BOYS }, now)).toBe(false);
  });
  it("the token carries its match list (and a token without one is an ordinary code token)", () => {
    const secret = "s".repeat(40);
    const base = { v: 1 as const, k: "c" as const, c: ORG, o: ORG, r: "referee" as const, t: null, iat: now, exp: now + 3600_000 };
    expect(verifyStaffToken(signStaffToken({ ...base, m: [M1, M2] }, secret), secret, now)).toMatchObject({ m: [M1, M2] });
    expect(verifyStaffToken(signStaffToken(base, secret), secret, now)).not.toHaveProperty("m");
    expect(verifyStaffToken(signStaffToken({ ...base, m: [] }, secret), secret, now)).toBeNull();
    expect(verifyStaffToken(signStaffToken({ ...base, m: ["not-a-uuid"] }, secret), secret, now)).toBeNull();
  });
});

describe("Show earlier days", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const tz = "Africa/Cairo";
  const m = (id: string, status: string, scheduled: string, ended: string | null = null) => ({ id, status, scheduled_time: scheduled, ended_at: ended, court_id: C1_BOYS, match_order: 1 });
  it("past days newest first, without today's list or cancelled matches", () => {
    const days = courtEarlierDays(
      [
        m("d1a", "completed", "2026-11-01T08:00:00Z", "2026-11-01T09:00:00Z"),
        m("d2b", "completed", "2026-11-02T10:00:00Z", "2026-11-02T11:00:00Z"),
        m("d2a", "completed", "2026-11-02T08:00:00Z", "2026-11-02T09:00:00Z"),
        m("today", "completed", "2026-11-03T08:00:00Z", "2026-11-03T09:00:00Z"),
        m("overdue", "scheduled", "2026-11-02T08:00:00Z"),
        m("gone", "cancelled", "2026-11-02T08:00:00Z"),
      ],
      tz,
      now,
    );
    expect(days.map((d) => [d.day, d.matches.map((x) => x.id)])).toEqual([
      ["2026-11-02", ["d2a", "d2b"]],
      ["2026-11-01", ["d1a"]],
    ]);
  });
});
