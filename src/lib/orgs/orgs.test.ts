import { describe, expect, it } from "vitest";
import { can, createSessionToken, verifySessionToken } from "../auth";
import { CODE_ALPHABET, CODE_LENGTH, eventCodePepper, formatEventCode, generateEventCode, hashEventCode, normalizeEventCode } from "./codes";
import { personFieldsVisibleFor } from "./personFields";
import { ORG_ROLES, isCodeRole, isOrgSlug, isUuid, permissionRole } from "./roles";
import { principalReaches } from "./scope";
import { isStaffTokenShaped, signStaffToken, staffSecret, verifyStaffToken, type StaffTokenPayload } from "../auth/staffToken";
import { safeNextPath, staffHome } from "../auth/staffRedirect";
import { openOAuthState, sealOAuthState } from "../auth/staffOAuth";
import { isAppRedirect, isStaffWebRedirect } from "../mobile/oauth";

process.env.AUTH_SECRET ??= "test-auth-secret-for-vitest-only-0123456789";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const CODE = "44444444-4444-4444-8444-444444444444";
const T1 = "55555555-5555-4555-8555-555555555555";
const SECRET = "s".repeat(40);
const NOW = 1_800_000_000_000;

describe("permission matrix", () => {
  const expected: Record<string, string[]> = {
    manage_tournament: ["owner", "admin", "manager"],
    clone_tournament: ["owner", "admin", "manager"],
    manage_teams: ["owner", "admin", "manager"],
    check_in: ["owner", "admin", "manager", "referee"],
    manage_groups: ["owner", "admin", "manager"],
    generate_matches: ["owner", "admin", "manager"],
    score_match: ["owner", "admin", "manager", "referee"],
    edit_bracket: ["owner", "admin", "manager", "referee"],
    control_screen: ["owner", "admin", "manager", "operator"],
    manage_screens: ["owner", "admin", "manager", "operator"],
    delete_screen: ["owner", "admin", "manager"],
    export: ["owner", "admin", "manager"],
    manage_sessions: ["owner", "admin", "manager"],
    manage_players: ["owner", "admin", "manager"],
    manage_seasons: ["owner", "admin", "manager"],
    check_in_session: ["owner", "admin", "manager", "referee"],
    send_messages: ["owner", "admin", "manager"],
    manage_codes: ["owner", "admin", "manager"],
    manage_platform: ["owner", "admin"],
  };
  for (const [action, roles] of Object.entries(expected)) {
    it(`${action}: ${roles.join(", ")}`, () => {
      for (const role of ORG_ROLES) expect(can(role, action as Parameters<typeof can>[1]), `${role} ${action}`).toBe(roles.includes(role));
    });
  }
  it("nobody without a role", () => {
    expect(can(null, "score_match")).toBe(false);
    expect(can(undefined, "export")).toBe(false);
  });
  it("an owner acts as an admin; event codes are referee or operator only", () => {
    expect(permissionRole("owner")).toBe("admin");
    expect(permissionRole("referee")).toBe("referee");
    expect(isCodeRole("referee") && isCodeRole("operator")).toBe(true);
    expect(isCodeRole("admin") || isCodeRole("owner") || isCodeRole("manager")).toBe(false);
  });
  it("ids and slugs", () => {
    expect(isUuid(ORG)).toBe(true);
    expect(isUuid("not-a-uuid") || isUuid("'; drop table x; --") || isUuid(null)).toBe(false);
    expect(isOrgSlug("move-beyond") && isOrgSlug("ab")).toBe(true);
    expect(isOrgSlug("-x") || isOrgSlug("Move") || isOrgSlug("a")).toBe(false);
  });
});

describe("event codes", () => {
  it("use a 31-symbol alphabet without look-alikes", () => {
    expect(CODE_ALPHABET.length).toBe(31);
    expect(new Set(CODE_ALPHABET).size).toBe(31);
    for (const ch of "01OIL") expect(CODE_ALPHABET).not.toContain(ch);
  });
  it("are 12 random symbols (≥ 10)", () => {
    const codes = Array.from({ length: 500 }, generateEventCode);
    expect(CODE_LENGTH).toBeGreaterThanOrEqual(10);
    for (const c of codes) {
      expect(c).toHaveLength(CODE_LENGTH);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });
  it("normalise what people type, and refuse what cannot be a code", () => {
    const c = generateEventCode();
    expect(normalizeEventCode(formatEventCode(c))).toBe(c);
    expect(normalizeEventCode(` ${formatEventCode(c).toLowerCase()} `)).toBe(c);
    expect(normalizeEventCode("ABCD-EFGH-JK")).toBeNull();
    expect(normalizeEventCode("ABCD-EFGH-JK0O")).toBeNull();
    expect(normalizeEventCode("hunter2")).toBeNull();
    expect(normalizeEventCode(42)).toBeNull();
  });
  it("are stored as a peppered HMAC-SHA256 hex digest, never in clear", () => {
    const c = generateEventCode();
    const h = hashEventCode(c);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(c);
    expect(hashEventCode(c)).toBe(h);
    expect(hashEventCode(generateEventCode())).not.toBe(h);
    // Keyed: without the pepper the stored value cannot be recomputed from a code.
    expect(hashEventCode(c, "p".repeat(32))).not.toBe(h);
    expect(hashEventCode(c, "p".repeat(32))).not.toBe(hashEventCode(c, "q".repeat(32)));
  });
  it("the pepper is required in production and derived in development", () => {
    expect(() => eventCodePepper({ NODE_ENV: "production" })).toThrow(/EVENT_CODE_PEPPER/);
    expect(() => eventCodePepper({ NODE_ENV: "production", EVENT_CODE_PEPPER: "short" })).toThrow(/EVENT_CODE_PEPPER/);
    expect(eventCodePepper({ NODE_ENV: "production", EVENT_CODE_PEPPER: "x".repeat(40) })).toBe("x".repeat(40));
    expect(eventCodePepper({ NODE_ENV: "development", AUTH_SECRET: "a" })).toBe(eventCodePepper({ NODE_ENV: "test", AUTH_SECRET: "a" }));
    expect(eventCodePepper({ NODE_ENV: "development", AUTH_SECRET: "a" })).not.toBe(eventCodePepper({ NODE_ENV: "development", AUTH_SECRET: "b" }));
  });
});

describe("staff tokens", () => {
  const member: StaffTokenPayload = { v: 1, k: "m", u: USER, o: ORG, r: "manager", iat: NOW, exp: NOW + 3600_000 };
  const code: StaffTokenPayload = { v: 1, k: "c", c: CODE, o: ORG, r: "referee", t: T1, iat: NOW, exp: NOW + 3600_000 };

  it("sign and verify, member and code", () => {
    const m = signStaffToken(member, SECRET);
    expect(m.startsWith("mbs1.")).toBe(true);
    expect(verifyStaffToken(m, SECRET, NOW + 1)).toEqual(member);
    expect(verifyStaffToken(signStaffToken(code, SECRET), SECRET, NOW + 1)).toEqual(code);
  });
  it("refuse a tampered payload or signature, and another secret", () => {
    const t = signStaffToken(member, SECRET);
    const [prefix, body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...member, r: "owner", o: OTHER })).toString("base64url");
    expect(verifyStaffToken(`${prefix}.${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifyStaffToken(`${prefix}.${body}.${sig.slice(0, -2)}AA`, SECRET, NOW)).toBeNull();
    expect(verifyStaffToken(`${prefix}.${body}`, SECRET, NOW)).toBeNull();
    expect(verifyStaffToken(t, "x".repeat(40), NOW)).toBeNull();
  });
  it("refuse expired, from-the-future and over-long tokens", () => {
    expect(verifyStaffToken(signStaffToken(member, SECRET), SECRET, NOW + 3600_000)).toBeNull();
    expect(verifyStaffToken(signStaffToken({ ...member, iat: NOW + 3600_000, exp: NOW + 7200_000 }, SECRET), SECRET, NOW)).toBeNull();
    expect(verifyStaffToken(signStaffToken({ ...member, exp: NOW + 30 * 86_400_000 }, SECRET), SECRET, NOW)).toBeNull();
  });
  it("refuse a payload with a role a code may not have", () => {
    const bad = { ...code, r: "admin" } as unknown as StaffTokenPayload;
    expect(verifyStaffToken(signStaffToken(bad, SECRET), SECRET, NOW)).toBeNull();
  });
  it("fail closed in production without STAFF_SESSION_SECRET", () => {
    expect(() => staffSecret({ NODE_ENV: "production", AUTH_SECRET: "a".repeat(40) })).toThrow(/STAFF_SESSION_SECRET/);
    expect(() => staffSecret({ NODE_ENV: "production", STAFF_SESSION_SECRET: "short" })).toThrow();
    expect(staffSecret({ NODE_ENV: "production", STAFF_SESSION_SECRET: SECRET })).toBe(SECRET);
    // Development and tests: derived from AUTH_SECRET, never equal to it.
    const dev = staffSecret({ NODE_ENV: "development", AUTH_SECRET: "a".repeat(40) });
    expect(dev).not.toBe("a".repeat(40));
    expect(dev.length).toBeGreaterThanOrEqual(32);
  });
});

describe("staff and user tokens are never taken for one another", () => {
  const jwt = `${Buffer.from('{"alg":"ES256","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"sub":"x","aud":"authenticated"}').toString("base64url")}.sig`;
  it("a staff token, of either format, is staff-shaped; a Supabase JWT is not", () => {
    expect(isStaffTokenShaped(signStaffToken({ v: 1, k: "m", u: USER, o: ORG, r: "owner", iat: NOW, exp: NOW + 1000 }, SECRET))).toBe(true);
    expect(isStaffTokenShaped(createSessionToken("referee"))).toBe(true);
    expect(isStaffTokenShaped(jwt)).toBe(false);
    expect(isStaffTokenShaped("inst.1.sig")).toBe(false);
  });
  it("the staff verifier refuses a JWT and a legacy token; the legacy verifier refuses an mbs1 token", () => {
    expect(verifyStaffToken(jwt, SECRET, NOW)).toBeNull();
    expect(verifyStaffToken(createSessionToken("admin"), SECRET)).toBeNull();
    const mbs = signStaffToken({ v: 1, k: "m", u: USER, o: ORG, r: "admin", iat: Date.now(), exp: Date.now() + 1000 }, staffSecret());
    expect(verifySessionToken(mbs)).toBeNull();
    expect(verifySessionToken(jwt)).toBeNull();
    expect(verifySessionToken(createSessionToken("manager"))).toBe("manager");
  });
});

describe("where a staff member may reach", () => {
  const staff = { orgId: ORG, scopeTournamentId: null };
  it("own organisation only; not found and not yours alike", () => {
    expect(principalReaches(staff, { orgId: ORG, tournamentId: T1, kind: "tournament" })).toBe(true);
    expect(principalReaches(staff, { orgId: OTHER, tournamentId: T1, kind: "tournament" })).toBe(false);
    expect(principalReaches(staff, null)).toBe(false);
  });
  it("a code scoped to one tournament reaches only that one", () => {
    const scoped = { orgId: ORG, scopeTournamentId: T1 };
    expect(principalReaches(scoped, { orgId: ORG, tournamentId: T1, kind: "tournament" })).toBe(true);
    expect(principalReaches(scoped, { orgId: ORG, tournamentId: OTHER, kind: "tournament" })).toBe(false);
    expect(principalReaches(scoped, { orgId: ORG, tournamentId: null, kind: null })).toBe(false);
  });
});

describe("staff sign-in redirects", () => {
  it("next is a path on this site only", () => {
    expect(safeNextPath("/admin/tournaments")).toBe("/admin/tournaments");
    expect(safeNextPath("/referee?x=1")).toBe("/referee?x=1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", "admin", `/${"a".repeat(400)}`, "/a\nb", null]) {
      expect(safeNextPath(bad), String(bad)).toBeNull();
    }
  });
  it("each role's home", () => {
    expect(staffHome("referee")).toBe("/referee");
    expect(staffHome("operator")).toBe("/operator");
    expect(staffHome("admin")).toBe("/admin/tournaments");
  });
  it("the Google callback is exactly the site's own", () => {
    const site = "https://tour.mbeg.org";
    expect(isStaffWebRedirect("https://tour.mbeg.org/staff/auth/callback", site)).toBe(true);
    for (const bad of [
      "https://tour.mbeg.org/staff/auth/callback?x=1",
      "https://tour.mbeg.org/staff/auth/callback/../../evil",
      "https://tour.mbeg.org.evil.example/staff/auth/callback",
      "https://evil.example/staff/auth/callback",
      "http://tour.mbeg.org/staff/auth/callback",
      "https://user@tour.mbeg.org/staff/auth/callback",
    ]) {
      expect(isStaffWebRedirect(bad, site), bad).toBe(false);
      expect(isAppRedirect(bad, { siteOrigin: site }), bad).toBe(false);
    }
    expect(isStaffWebRedirect("https://evil.example/staff/auth/callback", "https://evil.example/"), "only when the server names it").toBe(true);
    expect(isStaffWebRedirect("http://evil.example/staff/auth/callback", "http://evil.example")).toBe(false);
    expect(isAppRedirect("https://tour.mbeg.org/staff/auth/callback", { siteOrigin: site })).toBe(true);
    // Without the site named (the app's own sign-in route), the web callback is not an app redirect.
    expect(isAppRedirect("https://tour.mbeg.org/staff/auth/callback")).toBe(false);
  });
  it("the OAuth state cookie is signed and expires", () => {
    const verifier = "v".repeat(64);
    const sealed = sealOAuthState(verifier, "/admin/players", NOW, SECRET);
    expect(openOAuthState(sealed, NOW + 1000, SECRET)).toEqual({ verifier, next: "/admin/players" });
    expect(openOAuthState(sealed, NOW + 11 * 60_000, SECRET)).toBeNull();
    expect(openOAuthState(sealed, NOW, "x".repeat(40))).toBeNull();
    const [body, sig] = sealed.split(".");
    const forged = Buffer.from(JSON.stringify({ v: verifier, n: "https://evil.example", exp: NOW + 60_000 })).toString("base64url");
    expect(openOAuthState(`${forged}.${sig}`, NOW, SECRET)).toBeNull();
    expect(openOAuthState(`${body}.${sig}x`, NOW, SECRET)).toBeNull();
    // A next that is not a site path is dropped even when signed.
    expect(openOAuthState(sealOAuthState(verifier, "//evil.example", NOW, SECRET), NOW, SECRET)?.next).toBeNull();
  });
});

describe("person fields (who sees a player's mobile, email, birth year, photo, consents)", () => {
  it("an organisation that created or added the player sees them", () => {
    for (const source of ["backfill", "admin", "registration", "tournament", "league", "link"]) {
      expect(personFieldsVisibleFor(source, 0), source).toBe(true);
      expect(personFieldsVisibleFor(source, 3), source).toBe(true);
    }
  });
  it("a profile only matched by a typed mobile is hidden while another organisation has it", () => {
    expect(personFieldsVisibleFor("matched", 1)).toBe(false);
    expect(personFieldsVisibleFor("matched", 0)).toBe(true);
  });
  it("not the organisation's player: nothing", () => {
    expect(personFieldsVisibleFor(null, 0)).toBe(false);
  });
});
