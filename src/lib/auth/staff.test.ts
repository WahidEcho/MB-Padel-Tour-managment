import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Staff resolution against an in-memory stand-in for the few PostgREST calls it
 * makes: membership, platform admins, codes and organisations are re-read on
 * every request, so removal, suspension, revocation and expiry bite at once.
 */
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private op: "select" | "update" = "select";
  private patch: Row = {};
  private single = false;
  private filters: ((r: Row) => boolean)[] = [];
  constructor(private table: string) {}
  select() {
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  eq(k: string, v: unknown) {
    this.filters.push((r) => r[k] === v);
    return this;
  }
  in(k: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[k]));
    return this;
  }
  order() {
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  private run(): unknown {
    const hits = (tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of hits) Object.assign(r, this.patch);
      return null;
    }
    const out = hits.map((r) => ({ ...r }));
    return this.single ? (out[0] ?? null) : out;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve({ data: this.run(), error: null as null }).then(ok, bad);
  }
}

vi.mock("../supabase", () => ({ db: () => ({ from: (t: string) => new Query(t) }) }));

process.env.AUTH_SECRET ??= "test-auth-secret-for-vitest-only-0123456789";
process.env.ADMIN_PASSWORD = "shared-admin-pass";
process.env.REFEREE_PASSWORD = "shared-ref-pass";

const { resolveStaffToken, signInWithAccessCode, memberToken, staffOrgsFor, finishStaffSignIn } = await import("./staff");
const { createSessionToken } = await import("../auth");
const { signStaffToken, staffSecret } = await import("./staffToken");
const { generateEventCode, hashEventCode, formatEventCode } = await import("../orgs/codes");

const MB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const OWNER = "66666666-6666-4666-8666-666666666666";
const CODE_ID = "44444444-4444-4444-8444-444444444444";
const T1 = "55555555-5555-4555-8555-555555555555";
const code = generateEventCode();

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.organizations = [
    { id: MB, slug: "move-beyond", name: "Move Beyond", status: "approved" },
    { id: ORG, slug: "club-a", name: "Club A", status: "approved" },
    { id: OTHER, slug: "club-b", name: "Club B", status: "approved" },
  ];
  tables.organization_members = [
    { organization_id: ORG, auth_user_id: USER, role: "manager", status: "active" },
    { organization_id: OTHER, auth_user_id: USER, role: "referee", status: "removed" },
  ];
  tables.platform_admins = [{ auth_user_id: OWNER }];
  tables.organization_codes = [
    // An operator (TV) code: the generic code rules. Every referee code also needs a PIN (tested below and in e2e:referees).
    { id: CODE_ID, organization_id: ORG, role: "operator", tournament_id: T1, code_hash: hashEventCode(code), expires_at: null, revoked_at: null },
  ];
});

const codeToken = (over: Partial<{ o: string; t: string | null; exp: number }> = {}) =>
  signStaffToken({ v: 1, k: "c", c: CODE_ID, o: over.o ?? ORG, r: "operator", t: over.t === undefined ? T1 : over.t, iat: Date.now(), exp: over.exp ?? Date.now() + 3600_000 }, staffSecret());

describe("members", () => {
  it("an active member acts with the role in the database now", async () => {
    const token = memberToken(USER, ORG, "owner"); // the token's role is not trusted
    const r = await resolveStaffToken(token);
    expect(r).toMatchObject({ ok: true, staff: { kind: "member", orgId: ORG, orgRole: "manager", role: "manager", userId: USER, platformAdmin: false } });
  });
  it("removal takes effect on the next request", async () => {
    const token = memberToken(USER, ORG, "manager");
    (tables.organization_members[0] as Row).status = "removed";
    expect(await resolveStaffToken(token)).toEqual({ ok: false, reason: "membership_ended" });
  });
  it("a token for an organisation the person was removed from is refused", async () => {
    expect(await resolveStaffToken(memberToken(USER, OTHER, "referee"))).toEqual({ ok: false, reason: "membership_ended" });
  });
  it("suspending the organisation takes effect on the next request", async () => {
    const token = memberToken(USER, ORG, "manager");
    (tables.organizations[1] as Row).status = "suspended";
    expect(await resolveStaffToken(token)).toEqual({ ok: false, reason: "org_suspended" });
    (tables.organizations[1] as Row).status = "applied";
    expect(await resolveStaffToken(token)).toEqual({ ok: false, reason: "org_pending" });
  });
  it("a platform admin acts as the owner of whichever organisation they pick", async () => {
    const r = await resolveStaffToken(memberToken(OWNER, OTHER, "owner"));
    expect(r).toMatchObject({ ok: true, staff: { orgId: OTHER, orgRole: "owner", role: "admin", platformAdmin: true } });
    expect((await staffOrgsFor(OWNER)).map((o) => o.slug).sort()).toEqual(["club-a", "club-b", "move-beyond"]);
  });
  it("sign-in picks only active memberships of approved organisations", async () => {
    expect((await staffOrgsFor(USER)).map((o) => [o.slug, o.role])).toEqual([["club-a", "manager"]]);
    const done = await finishStaffSignIn(USER);
    expect(done).toMatchObject({ ok: true, org: { id: ORG }, choices: 1 });
    expect(await finishStaffSignIn("77777777-7777-4777-8777-777777777777")).toEqual({ ok: false, reason: "no_org" });
  });
});

describe("event codes", () => {
  it("resolve to {org, role, scope}", async () => {
    expect(await resolveStaffToken(codeToken())).toMatchObject({
      ok: true,
      staff: { kind: "code", orgId: ORG, role: "operator", codeId: CODE_ID, scopeTournamentId: T1, userId: null, platformAdmin: false },
    });
  });
  it("a referee code (whole-event) is refused without a referee: every referee code needs a PIN", async () => {
    (tables.organization_codes[0] as Row).role = "referee";
    expect(await resolveStaffToken(codeToken())).toEqual({ ok: false, reason: "pin_required" });
    expect(await signInWithAccessCode(code, 24)).toMatchObject({ ok: false, reason: "pin_required", master: false });
  });
  it("a revoked code fails the next request, with its own reason", async () => {
    const token = codeToken();
    (tables.organization_codes[0] as Row).revoked_at = new Date().toISOString();
    expect(await resolveStaffToken(token)).toEqual({ ok: false, reason: "code_revoked" });
  });
  it("an expired code fails", async () => {
    const token = codeToken();
    (tables.organization_codes[0] as Row).expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await resolveStaffToken(token)).toEqual({ ok: false, reason: "code_expired" });
  });
  it("a token naming another organisation for a code is refused", async () => {
    expect(await resolveStaffToken(codeToken({ o: OTHER }))).toEqual({ ok: false, reason: "signed_out" });
  });
  it("the scope comes from the code row, not the token", async () => {
    const r = await resolveStaffToken(codeToken({ t: null }));
    expect(r).toMatchObject({ ok: true, staff: { scopeTournamentId: T1 } });
  });
  it("sign-in by code: the formatted, lower-case code works; the stored hash does not", async () => {
    const ok = await signInWithAccessCode(formatEventCode(code).toLowerCase(), 24);
    expect(ok).toMatchObject({ ok: true, kind: "code", role: "operator", orgId: ORG, scopeTournamentId: T1 });
    expect(ok.ok && ok.token.startsWith("mbs1.")).toBe(true);
    expect(await signInWithAccessCode(hashEventCode(code), 24)).toMatchObject({ ok: false, reason: "wrong_code" });
    expect(await signInWithAccessCode(generateEventCode(), 24)).toMatchObject({ ok: false, reason: "wrong_code" });
  });
  it("sign-in with a revoked or expired code says so", async () => {
    (tables.organization_codes[0] as Row).revoked_at = new Date().toISOString();
    expect(await signInWithAccessCode(code, 24)).toMatchObject({ ok: false, reason: "code_revoked" });
    (tables.organization_codes[0] as Row).revoked_at = null;
    (tables.organization_codes[0] as Row).expires_at = new Date(Date.now() - 1).toISOString();
    expect(await signInWithAccessCode(code, 24)).toMatchObject({ ok: false, reason: "code_expired" });
  });
  it("a code session never outlives its code", async () => {
    const until = Date.now() + 3600_000;
    (tables.organization_codes[0] as Row).expires_at = new Date(until).toISOString();
    const r = await signInWithAccessCode(code, 24 * 7);
    expect(r.ok && Date.parse(r.expiresAt)).toBeLessThanOrEqual(until);
  });
});

describe("shared role passwords: Move Beyond only", () => {
  it("a shared token acts for Move Beyond", async () => {
    expect(await resolveStaffToken(createSessionToken("referee"))).toMatchObject({ ok: true, staff: { kind: "shared", orgId: MB, role: "referee" } });
  });
  it("and stops working if Move Beyond is not there", async () => {
    tables.organizations = tables.organizations.filter((o) => o.id !== MB);
    expect(await resolveStaffToken(createSessionToken("admin"))).toEqual({ ok: false, reason: "signed_out" });
  });
  it("sign-in with the shared password", async () => {
    expect(await signInWithAccessCode("shared-ref-pass", 24)).toMatchObject({ ok: true, kind: "shared", role: "referee", orgId: MB });
  });
  it("the shared admin password is never a platform admin", async () => {
    expect(await resolveStaffToken(createSessionToken("admin"))).toMatchObject({ ok: true, staff: { kind: "shared", role: "admin", platformAdmin: false } });
  });
  it("anything else is not a staff token", async () => {
    expect(await resolveStaffToken("eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig")).toBeNull();
    expect(await resolveStaffToken("mbs1.garbage.sig")).toEqual({ ok: false, reason: "signed_out" });
  });
});

describe("malformed signatures never throw (multi-byte characters of the right string length)", () => {
  /** The same string length, more bytes: "é" is one UTF-16 unit and two UTF-8 bytes. */
  const multiByte = (token: string) => `${token.slice(0, -1)}é`;
  it("safeEqual compares bytes, not string length", async () => {
    const { safeEqual } = await import("./safeEqual");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abé", "abc")).toBe(false);
    expect(safeEqual("abc", "abé")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("a", "")).toBe(false);
  });
  it("an mbs1 staff token", async () => {
    const bad = multiByte(memberToken(USER, ORG, "manager"));
    expect(await resolveStaffToken(bad)).toEqual({ ok: false, reason: "signed_out" });
  });
  it("a shared-password token", async () => {
    const bad = multiByte(createSessionToken("admin"));
    expect(await resolveStaffToken(bad)).toBeNull();
    const { verifySessionToken } = await import("../auth");
    expect(verifySessionToken(bad)).toBeNull();
  });
  it("the Google sign-in state cookie", async () => {
    const { sealOAuthState, openOAuthState } = await import("./staffOAuth");
    const sealed = sealOAuthState("v".repeat(43), "/admin");
    expect(openOAuthState(sealed)).not.toBeNull();
    expect(openOAuthState(multiByte(sealed))).toBeNull();
  });
  it("the app's install token", async () => {
    const { verifyInstallToken } = await import("../mobile/identity");
    expect(verifyInstallToken(`id.${"n".repeat(16)}.${"s".repeat(42)}é`)).toBeNull();
  });
});

describe("the staff cookie", () => {
  it("is __Host- and Secure off localhost; plain only on a local development server", async () => {
    const { staffCookieFor, staffCookieNames } = await import("../auth");
    expect(staffCookieFor("tour.mbeg.org")).toEqual({ name: "__Host-mb_session", secure: true });
    expect(staffCookieFor(null)).toEqual({ name: "__Host-mb_session", secure: true });
    expect(staffCookieFor("localhost:3077")).toEqual({ name: "mb_session", secure: false });
    expect(staffCookieFor("127.0.0.1:3000")).toEqual({ name: "mb_session", secure: false });
    expect(staffCookieFor("localhost.evil.example")).toEqual({ name: "__Host-mb_session", secure: true });
    expect(staffCookieNames("tour.mbeg.org")).toEqual(["__Host-mb_session"]);
    expect(staffCookieNames("localhost:3077")).toEqual(["__Host-mb_session", "mb_session"]);
  });
});

describe("staff login brakes", () => {
  it("bucket codes by a hashed prefix, never storing the characters", async () => {
    const { codePrefixKey } = await import("../staffLogin");
    const k = codePrefixKey("k7qm-w3xt-9hrp")!;
    expect(k).toBe(codePrefixKey("K7QMW3XT9HRP"));
    expect(k).not.toMatch(/K7QM/i);
    expect(codePrefixKey("ABCD-W3XT-9HRP")).not.toBe(k);
    expect(codePrefixKey("")).toBeNull();
  });
  it("have no platform-wide ceiling one attacker could fill", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../staffLogin.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/staff-login:all/);
  });
});
