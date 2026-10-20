import { describe, expect, it } from "vitest";
import { MASTER_REFEREE_PERMISSIONS, can, staffCan, type Permission } from "../auth";
import { signStaffToken, verifyStaffToken } from "../auth/staffToken";
import { isScopedCode, principalReaches } from "../orgs/scope";
import { masterCovers } from "./assistance";
import { codeNeedsPin, sessionIsCurrent } from "./server";
import { PIN_LOCK, PIN_LOCK_MINUTES } from "./rules";

process.env.AUTH_SECRET ??= "test-auth-secret-for-vitest-only-0123456789";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BOYS = "55555555-5555-4555-8555-555555555555";
const GIRLS = "66666666-6666-4666-8666-666666666666";
const ELSEWHERE = "77777777-7777-4777-8777-777777777777";
const REF = "a1111111-1111-4111-8111-111111111111";
const SES = "b1111111-1111-4111-8111-111111111111";
const CODE = "c1111111-1111-4111-8111-111111111111";
const SECRET = "s".repeat(40);

const master = { kind: "code", role: "referee" as const, referee: { role: "master_referee" } };
const courtRef = { kind: "code", role: "referee" as const, referee: { role: "referee" } };

describe("master referee permissions", () => {
  it("adds the desk's day-of-play tools (master_desk) to a referee's, nothing else", () => {
    for (const p of ["score_match", "check_in", "master_desk"] as Permission[]) expect(staffCan(master, p), p).toBe(true);
    // Audit L3: deleting matches, brackets (slots, publish, reset), groups and resetting the placement draws are the organiser's.
    for (const p of ["edit_bracket", "generate_matches", "manage_groups", "manage_tournament", "manage_teams", "manage_codes", "manage_referees", "send_messages", "manage_members", "refund_registrations", "manage_platform", "control_screen", "export", "manage_registrations"] as Permission[]) {
      expect(staffCan(master, p), p).toBe(false);
    }
  });
  it("a court referee keeps a referee's permissions only", () => {
    expect(staffCan(courtRef, "score_match")).toBe(true);
    expect(staffCan(courtRef, "generate_matches")).toBe(false);
    expect(staffCan(courtRef, "manage_groups")).toBe(false);
    expect(staffCan(courtRef, "master_desk")).toBe(false);
  });
  it("the organiser's staff keep every desk tool", () => {
    for (const p of ["master_desk", "generate_matches", "manage_groups", "edit_bracket"] as Permission[]) {
      expect(can("admin", p), p).toBe(true);
      expect(can("manager", p), p).toBe(true);
    }
  });
  it("a member never gets master powers from a stray field", () => {
    expect(staffCan({ kind: "member", role: "referee", referee: { role: "master_referee" } }, "generate_matches")).toBe(false);
  });
  it("the roster is the admins' and managers'", () => {
    expect(can("admin", "manage_referees")).toBe(true);
    expect(can("manager", "manage_referees")).toBe(true);
    expect(can("referee", "manage_referees")).toBe(false);
    expect(MASTER_REFEREE_PERMISSIONS.has("manage_referees")).toBe(false);
  });
});

describe("a master referee's reach", () => {
  const m = { orgId: ORG, scopeTournamentId: null, scopeTournamentIds: [BOYS, GIRLS] };
  it("every match and both tournaments of its events, every court", () => {
    expect(principalReaches(m, { orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "tournament" })).toBe(true);
    expect(principalReaches(m, { orgId: ORG, tournamentId: GIRLS, kind: "tournament", ref: "match", courtId: "x" })).toBe(true);
    expect(principalReaches(m, { orgId: ORG, tournamentId: GIRLS, kind: "tournament", ref: "match", courtId: null })).toBe(true);
  });
  it("never another event, another organisation, or anything that is not a tournament or match", () => {
    expect(principalReaches(m, { orgId: ORG, tournamentId: ELSEWHERE, kind: "tournament", ref: "match" })).toBe(false);
    expect(principalReaches(m, { orgId: OTHER, tournamentId: BOYS, kind: "tournament", ref: "match" })).toBe(false);
    expect(principalReaches(m, { orgId: ORG, tournamentId: BOYS, kind: null, ref: "other" })).toBe(false);
    expect(principalReaches(m, { orgId: ORG, tournamentId: null, kind: null })).toBe(false);
    expect(principalReaches({ ...m, scopeTournamentIds: [] }, { orgId: ORG, tournamentId: BOYS, kind: "tournament", ref: "match" })).toBe(false);
  });
  it("is a scoped code: no organisation-level work", () => {
    expect(isScopedCode(m)).toBe(true);
  });
  it("covers calls of its events only", () => {
    expect(masterCovers(m, { organization_id: ORG, tournament_id: GIRLS })).toBe(true);
    expect(masterCovers(m, { organization_id: ORG, tournament_id: ELSEWHERE })).toBe(false);
    expect(masterCovers(m, { organization_id: OTHER, tournament_id: GIRLS })).toBe(false);
    expect(masterCovers(m, { organization_id: ORG, tournament_id: null })).toBe(false);
  });
});

describe("tokens name the referee and their sign-in", () => {
  const now = Date.now();
  const base = { v: 1 as const, k: "c" as const, c: CODE, o: ORG, r: "referee" as const, t: null, iat: now, exp: now + 3600_000 };
  it("round-trips p and s", () => {
    const p = verifyStaffToken(signStaffToken({ ...base, p: REF, s: SES }, SECRET), SECRET, now);
    expect(p && p.k === "c" && p.p === REF && p.s === SES).toBe(true);
  });
  it("a code token without them still verifies (event codes, operators)", () => {
    const p = verifyStaffToken(signStaffToken(base, SECRET), SECRET, now);
    expect(p && p.k === "c" && p.p === undefined && p.s === undefined).toBe(true);
  });
  it("refuses one without the other, or a malformed id", () => {
    expect(verifyStaffToken(signStaffToken({ ...base, p: REF } as never, SECRET), SECRET, now)).toBeNull();
    expect(verifyStaffToken(signStaffToken({ ...base, p: REF, s: "nope" }, SECRET), SECRET, now)).toBeNull();
  });
  it("carry-over tokens keep the referee", () => {
    const p = verifyStaffToken(signStaffToken({ ...base, m: [BOYS], p: REF, s: SES }, SECRET), SECRET, now);
    expect(p && p.k === "c" && p.m?.[0] === BOYS && p.p === REF).toBe(true);
  });
});

describe("On court now", () => {
  const now = Date.parse("2026-11-02T10:00:00Z");
  it("counts a sign-in seen in the last 20 minutes, not ended, not expired", () => {
    expect(sessionIsCurrent({ ended_at: null, expires_at: "2026-11-03T10:00:00Z", last_seen_at: "2026-11-02T09:45:00Z" }, now)).toBe(true);
    expect(sessionIsCurrent({ ended_at: null, expires_at: "2026-11-03T10:00:00Z", last_seen_at: "2026-11-02T09:39:00Z" }, now)).toBe(false);
    expect(sessionIsCurrent({ ended_at: "2026-11-02T09:59:00Z", expires_at: "2026-11-03T10:00:00Z", last_seen_at: "2026-11-02T09:59:00Z" }, now)).toBe(false);
    expect(sessionIsCurrent({ ended_at: null, expires_at: "2026-11-02T09:59:00Z", last_seen_at: "2026-11-02T09:59:00Z" }, now)).toBe(false);
  });
});

describe("every referee code needs a PIN (owner's decision)", () => {
  it("court, whole-event and master codes; never an operator (TV) code", () => {
    expect(codeNeedsPin({ role: "referee", court_name: "Court 1" })).toBe(true);
    expect(codeNeedsPin({ role: "referee", court_name: null })).toBe(true);
    expect(codeNeedsPin({ role: "master_referee", court_name: null })).toBe(true);
    expect(codeNeedsPin({ role: "operator", court_name: null })).toBe(false);
  });
  it("five wrong PINs lock a code for five minutes", () => {
    expect(PIN_LOCK).toEqual({ limit: 5, windowSeconds: 300 });
    expect(PIN_LOCK_MINUTES).toBe(5);
  });
});
