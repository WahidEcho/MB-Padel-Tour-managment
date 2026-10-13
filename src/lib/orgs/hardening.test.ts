/**
 * Security review of Phase 0.5B (H1, M1–M4, L1–L7): the pure rules behind each
 * fix. The attacks themselves run against the stand-in in scripts/e2e/organizations.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLE_RANK, roleOnAccept, type OrgRole } from "./roles";
import { personFieldsHiddenFor, personFieldsVisibleFor } from "./personFields";
import { INVITE_CONFIRM_TTL_MS, openInviteConfirm, sealInviteConfirm } from "./inviteToken";
import { applicationSlug, nameKey, orgNameProblem, slugFromName } from "./profile";
import { PERSONAL_ACCOUNT_ONLY, staffCan } from "../auth";
import { refundRateLimit, takeRateLimit } from "../ratelimit";
import { staffLoginBuckets } from "../staffLogin";
import { noAutolink, textToHtml } from "../email/layout";
import { vetImageBytes, MAX_PIXELS } from "../upload";

process.env.AUTH_SECRET ??= "test-auth-secret-for-vitest-only-0123456789";

const U = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";

describe("H1/M1: a profile an organisation does not vouch for", () => {
  it("is hidden when it only matched it (or has no row) while another organisation has the player", () => {
    expect(personFieldsHiddenFor("matched", 1)).toBe(true);
    expect(personFieldsHiddenFor(null, 1)).toBe(true);
    expect(personFieldsHiddenFor(undefined, 2)).toBe(true);
  });
  it("is not hidden when nobody else has it, or when the organisation created, added or was shown it", () => {
    expect(personFieldsHiddenFor("matched", 0)).toBe(false);
    expect(personFieldsHiddenFor(null, 0)).toBe(false);
    for (const s of ["backfill", "admin", "registration", "tournament", "league", "link"]) {
      expect(personFieldsHiddenFor(s, 3), s).toBe(false);
      expect(personFieldsVisibleFor(s, 3), s).toBe(true);
    }
  });
});

describe("M2: the shared role passwords never manage members or the profile", () => {
  it("refuses the personal-account-only permissions to a shared password acting as admin", () => {
    const shared = { role: "admin" as const, kind: "shared" };
    for (const p of PERSONAL_ACCOUNT_ONLY) expect(staffCan(shared, p), p).toBe(false);
    expect(staffCan(shared, "manage_tournament")).toBe(true);
    expect(staffCan(shared, "send_messages")).toBe(true);
  });
  it("still lets a member admin or owner do them", () => {
    expect(staffCan({ role: "admin", kind: "member" }, "manage_members")).toBe(true);
    expect(staffCan({ role: "owner", kind: "member" }, "manage_org_profile")).toBe(true);
    expect(staffCan({ role: "manager", kind: "member" }, "manage_members")).toBe(false);
    expect(staffCan({ role: "referee", kind: "code" }, "manage_members")).toBe(false);
  });
});

/** An in-memory request_counters with PostgREST's filter semantics and a delay per call, to race. */
function fakeCounters() {
  const rows = new Map<string, { window_started_at: string; count: number }>();
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
  type F = { col: string; val: unknown };
  const match = (key: string, f: F[]) => {
    const row = rows.get(key);
    return Boolean(row) && f.every((x) => (x.col === "bucket_key" ? true : String((row as Record<string, unknown>)[x.col]) === String(x.val)));
  };
  const client = {
    from() {
      return {
        select() {
          const f: F[] = [];
          const q = {
            eq(col: string, val: unknown) {
              f.push({ col, val });
              return q;
            },
            async maybeSingle() {
              await tick();
              const key = String(f.find((x) => x.col === "bucket_key")?.val);
              const row = rows.get(key);
              return { data: row ? { ...row } : null, error: null };
            },
          };
          return q;
        },
        upsert(row: { bucket_key: string; window_started_at: string; count: number }, o: { ignoreDuplicates?: boolean }) {
          return {
            async select() {
              await tick();
              if (rows.has(row.bucket_key)) {
                if (o.ignoreDuplicates) return { data: [], error: null };
              }
              rows.set(row.bucket_key, { window_started_at: row.window_started_at, count: row.count });
              return { data: [{ bucket_key: row.bucket_key }], error: null };
            },
          };
        },
        update(patch: Partial<{ window_started_at: string; count: number }>) {
          const f: F[] = [];
          const q = {
            eq(col: string, val: unknown) {
              f.push({ col, val });
              return q;
            },
            async select() {
              await tick();
              const key = String(f.find((x) => x.col === "bucket_key")?.val);
              if (!match(key, f)) return { data: [], error: null };
              rows.set(key, { ...rows.get(key)!, ...patch });
              return { data: [{ bucket_key: key }], error: null };
            },
          };
          return q;
        },
      };
    },
  };
  return { rows, client: client as unknown as Parameters<typeof takeRateLimit>[1] };
}

describe("M3: staff sign-in brakes count atomically, before the attempt", () => {
  it("a simultaneous wave never gets more attempts than the limit", async () => {
    const { rows, client } = fakeCounters();
    const opts = { key: "staff-login:203.0.113.9", limit: 20, windowSeconds: 900 };
    const results = await Promise.all(Array.from({ length: 60 }, () => takeRateLimit(opts, client, 200)));
    expect(results.filter((r) => r.allowed).length).toBe(20);
    expect(rows.get(opts.key)?.count).toBe(20);
  });
  it("a refund gives one back (right answers cost nothing in the end)", async () => {
    const { rows, client } = fakeCounters();
    const opts = { key: "staff-code:abc", limit: 3, windowSeconds: 900 };
    for (let i = 0; i < 5; i++) {
      const r = await takeRateLimit(opts, client);
      expect(r.allowed).toBe(true);
      await refundRateLimit(opts, client);
    }
    expect(rows.get(opts.key)?.count).toBe(0);
  });
  it("anything not shaped like an event code also meets a small per-address bucket", () => {
    expect(staffLoginBuckets("1.2.3.4", "K7QM-W3XT-9HRP").map((b) => b.key.split(":")[0])).toEqual(["staff-login", "staff-code"]);
    const pass = staffLoginBuckets("1.2.3.4", "hunter2").map((b) => b.key.split(":")[0]);
    expect(pass).toEqual(["staff-login", "staff-code", "staff-pass"]);
    expect(staffLoginBuckets("1.2.3.4").map((b) => b.key.split(":")[0])).toEqual(["staff-login"]);
  });
});

describe("M4: answering an invite after sign-in", () => {
  it("the confirm cookie names one person and one invite, and cannot be forged or kept", () => {
    const sealed = sealInviteConfirm({ userId: U, email: "a@example.com", inviteId: I }, 1_000_000);
    expect(openInviteConfirm(sealed, 1_000_001)).toEqual({ userId: U, email: "a@example.com", inviteId: I });
    expect(openInviteConfirm(sealed, 1_000_000 + INVITE_CONFIRM_TTL_MS + 1)).toBeNull();
    const [body, sig] = sealed.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), e: "b@example.com" })).toString("base64url");
    expect(openInviteConfirm(`${forged}.${sig}`, 1_000_001)).toBeNull();
    expect(openInviteConfirm(sealed, 1_000_001, "x".repeat(48))).toBeNull();
    expect(openInviteConfirm("not.a-cookie")).toBeNull();
  });
});

describe("L1: the last owner under concurrency", () => {
  it("the latest definition of the keep-owner trigger locks the organisation row before it looks", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const latest = readdirSync(dir)
      .sort()
      .filter((f) => /function organization_members_keep_owner/.test(readFileSync(join(dir, f), "utf8")))
      .at(-1)!;
    const sql = readFileSync(join(dir, latest), "utf8");
    const body = sql.slice(sql.indexOf("function organization_members_keep_owner"));
    const lock = body.search(/from organizations o where o\.id = org for update/);
    const check = body.search(/select 1 from organization_members m/);
    expect(lock, latest).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(check);
  });
});

describe("L2: what accepting an invite does to a role", () => {
  const roles: OrgRole[] = ["owner", "admin", "manager", "referee", "operator"];
  it("never lowers anybody", () => {
    for (const current of roles) for (const invited of roles) {
      const r = roleOnAccept(invited, "owner", current);
      expect(r && ROLE_RANK[r] >= ROLE_RANK[current], `${current} invited as ${invited}`).toBe(true);
    }
    expect(roleOnAccept("manager", "admin", "admin")).toBe("admin");
    expect(roleOnAccept("referee", "owner", "owner")).toBe("owner");
  });
  it("never does what the inviter could not do now", () => {
    expect(roleOnAccept("admin", "admin", null)).toBeNull(); // an admin cannot make admins
    expect(roleOnAccept("manager", null, null)).toBeNull(); // the sender left or lost the right
    expect(roleOnAccept("manager", "manager", null)).toBeNull();
    expect(roleOnAccept("manager", "admin", null)).toBe("manager");
    expect(roleOnAccept("owner", "platform", null)).toBe("owner");
    expect(roleOnAccept("admin", "admin", "manager")).toBe("manager"); // kept, not raised
    expect(roleOnAccept("admin", "owner", "manager")).toBe("admin");
  });
});

describe("L3: organisation names", () => {
  it("compares names with case, accents, spaces and punctuation ignored", () => {
    expect(nameKey("  move  BEYOND! ")).toBe(nameKey("Move Beyond"));
    expect(nameKey("Café Padel")).toBe(nameKey("cafe-padel"));
  });
  it("refuses Move Beyond's names, other organisations' names and addresses", () => {
    expect(orgNameProblem("MOVE   beyond", [])).toMatch(/Move Beyond/);
    expect(orgNameProblem("Move-Score", [])).toMatch(/Move Beyond/);
    expect(orgNameProblem("Move Beyond", [], { allowReserved: true })).toBeNull();
    expect(orgNameProblem("cairo padel club", ["Cairo Padel Club"])).toMatch(/already has that name/);
    expect(orgNameProblem("https://evil.example/login", [])).toMatch(/address/);
    expect(orgNameProblem("Padel.club", [])).toMatch(/address/);
    expect(orgNameProblem("Club x@y.com", [])).toMatch(/address/);
    expect(orgNameProblem("Cairo Padel Club", ["Giza Padel"])).toBeNull();
  });
  it("never turns an organisation's name into a link in an email", () => {
    for (const name of ["http://evil.example/x", "www.evil.example", "evil.com"]) {
      expect(textToHtml(`Join ${noAutolink(name)} on Move Score`)).not.toMatch(/<a /);
    }
    expect(textToHtml("Open https://tour.mbeg.org/x")).toMatch(/<a /);
  });
});

describe("L4: what an upload is stored as", () => {
  const png = (w: number, h: number) => {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  it("takes its type and extension from the bytes, not the claim", () => {
    expect(vetImageBytes(png(100, 50), "image/jpeg", { allow: ["image/jpeg", "image/png"] })).toEqual({ type: "image/png", ext: "png" });
  });
  it("refuses a canvas bigger than allowed (decompression bombs)", () => {
    expect(() => vetImageBytes(png(30000, 30000), "image/png", { allow: ["image/png"] })).toThrow(/pixels/);
    expect(() => vetImageBytes(png(MAX_PIXELS, 10), "image/png", { allow: ["image/png"] })).not.toThrow();
    expect(() => vetImageBytes(png(4096, 100), "image/png", { allow: ["image/png"], maxPixels: 2048 })).toThrow(/2048/);
    expect(() => vetImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "image/jpeg", { allow: ["image/jpeg"], maxPixels: 2048 })).toThrow(/size/);
  });
});

describe("L5: applications hold no name's address", () => {
  it("get a placeholder slug unrelated to the name", () => {
    const s = applicationSlug("a1B2c3D4e5F6a7b8");
    expect(s).toBe("applied-a1b2c3d4e5f6a7b8");
    expect(s).not.toContain(slugFromName("Cairo Padel Club"));
  });
});
