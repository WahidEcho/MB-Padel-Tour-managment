import { describe, expect, it } from "vitest";
import { ORG_ROLES, mayAssignRole, mayRemoveMember, wouldLeaveNoOwner, type OrgRole } from "./roles";
import { checkApplication, cleanPlan, cleanVenues, orgSkinDefaults, slugFromName, toPublicOrg, isLogoUrl } from "./profile";
import { generateInviteToken, hashInviteToken, isInviteTokenShaped, maskEmail } from "./inviteToken";
import { hashEventCode } from "./codes";
import { isOrgSlug } from "./roles";
import { toSkin } from "../mobile/projection";
import { FOLLOW_KINDS } from "../mobile/contract";

process.env.AUTH_SECRET ??= "test-auth-secret-for-vitest-only-0123456789";

describe("who may give which role", () => {
  it("owners give every role, to anyone", () => {
    for (const cur of [null, ...ORG_ROLES]) for (const next of ORG_ROLES) expect(mayAssignRole("owner", cur, next)).toBe(true);
  });
  it("admins give manager, referee, operator only, and never touch an owner or another admin", () => {
    expect(mayAssignRole("admin", null, "manager")).toBe(true);
    expect(mayAssignRole("admin", "referee", "manager")).toBe(true);
    expect(mayAssignRole("admin", null, "admin")).toBe(false);
    expect(mayAssignRole("admin", null, "owner")).toBe(false);
    expect(mayAssignRole("admin", "admin", "manager")).toBe(false);
    expect(mayAssignRole("admin", "owner", "manager")).toBe(false);
  });
  it("nobody else manages members", () => {
    for (const actor of ["manager", "referee", "operator"] as OrgRole[]) {
      for (const next of ORG_ROLES) expect(mayAssignRole(actor, null, next)).toBe(false);
      for (const cur of ORG_ROLES) expect(mayRemoveMember(actor, cur)).toBe(false);
    }
  });
  it("removing: owners anyone, admins only managers, referees and operators", () => {
    expect(mayRemoveMember("owner", "owner")).toBe(true);
    expect(mayRemoveMember("admin", "manager")).toBe(true);
    expect(mayRemoveMember("admin", "admin")).toBe(false);
    expect(mayRemoveMember("admin", "owner")).toBe(false);
  });
  it("the last owner stays", () => {
    expect(wouldLeaveNoOwner("owner", "admin", 1)).toBe(true);
    expect(wouldLeaveNoOwner("owner", "removed", 1)).toBe(true);
    expect(wouldLeaveNoOwner("owner", "admin", 2)).toBe(false);
    expect(wouldLeaveNoOwner("admin", "removed", 1)).toBe(false);
    expect(wouldLeaveNoOwner("owner", "owner", 1)).toBe(false);
  });
});

describe("invite tokens", () => {
  const PEPPER = "p".repeat(40);
  it("are 43 base64url characters, random each time", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(isInviteTokenShaped(a) && isInviteTokenShaped(b)).toBe(true);
    expect(a).not.toBe(b);
    for (const bad of ["", "x".repeat(42), "x".repeat(44), `${"x".repeat(42)}!`, null, 42]) expect(isInviteTokenShaped(bad)).toBe(false);
  });
  it("only an HMAC under the pepper is stored, never the token, and never the event-code hash of the same text", () => {
    const t = generateInviteToken();
    const h = hashInviteToken(t, PEPPER);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(hashInviteToken(t, PEPPER)).toBe(h);
    expect(hashInviteToken(t, "q".repeat(40))).not.toBe(h);
    expect(hashEventCode(t, PEPPER)).not.toBe(h);
  });
  it("pages show a masked address", () => {
    expect(maskEmail("someone@example.com")).toBe("so•••@example.com");
    expect(maskEmail("a@example.com")).toBe("a•••@example.com");
    expect(maskEmail("nonsense")).toBe("•••");
  });
});

describe("applications", () => {
  const good = { name: "Cairo Padel Club", contact_name: "Mona", contact_email: "Mona@Example.com", city: "Cairo" };
  it("keeps only the whitelisted fields, cleaned", () => {
    const r = checkApplication({ ...good, password: "hunter2", plan: { tier: "pro" }, about: "  We run\\nleagues  " });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contact_email).toBe("mona@example.com");
    expect(Object.keys(r.value).sort()).toEqual(["about", "city", "contact_email", "contact_name", "contact_phone", "country", "name", "sport", "website"]);
    expect(JSON.stringify(r.value)).not.toContain("hunter2");
  });
  it("refuses what is missing, malformed, too long or looks like a credential", () => {
    expect(checkApplication({ ...good, name: "" }).ok).toBe(false);
    expect(checkApplication({ ...good, contact_email: "nope" }).ok).toBe(false);
    expect(checkApplication({ ...good, website: "javascript:alert(1)" }).ok).toBe(false);
    expect(checkApplication({ ...good, contact_phone: "<script>" }).ok).toBe(false);
    expect(checkApplication({ ...good, about: "x".repeat(7000) }).ok).toBe(false);
    expect(checkApplication({ ...good, about: "our password: letmein" }).ok).toBe(false);
  });
  it("slugs are always valid organisation slugs", () => {
    for (const n of ["Cairo Padel Club!", "Académie Élite", "x", "—", "A".repeat(200), "Club -- 9"]) expect(isOrgSlug(slugFromName(n)), n).toBe(true);
    expect(slugFromName("Cairo Padel Club!")).toBe("cairo-padel-club");
  });
});

describe("profile and branding", () => {
  it("venues are cleaned and capped", () => {
    const v = cleanVenues([{ name: " Court House ", address: "1 Nile St", courts: "4" }, { name: "" }, { name: "B", courts: -3 }, "junk", ...Array(20).fill({ name: "X" })]);
    expect(v[0]).toEqual({ name: "Court House", address: "1 Nile St", courts: 4 });
    expect(v[1]).toEqual({ name: "B", address: null, courts: null });
    expect(v.length).toBe(10);
  });
  it("the plan has safe defaults and bounds", () => {
    expect(cleanPlan(null)).toEqual({ tier: "free", commission_pct: 0, subscription_status: "none", limits: {} });
    expect(cleanPlan({ tier: "gold", commission_pct: 250, subscription_status: "paid" })).toMatchObject({ tier: "free", commission_pct: 100, subscription_status: "none" });
    expect(cleanPlan({ tier: "pro", commission_pct: "7.555", subscription_status: "active" })).toMatchObject({ tier: "pro", commission_pct: 7.56, subscription_status: "active" });
  });
  it("the public profile carries public fields only", () => {
    const row = {
      slug: "club",
      name: "Club",
      logo_url: "javascript:x",
      colors: { primary: "#AABBCC", accent: "red" },
      about: "Hi",
      city: null,
      country: "EG",
      venues: [{ name: "V" }],
      application: { contact_email: "secret@example.com" },
      plan: { tier: "pro", commission_pct: 9 },
      members: ["owner@example.com"],
    };
    const p = toPublicOrg(row);
    expect(Object.keys(p).sort()).toEqual(["about", "city", "colors", "country", "logoUrl", "name", "slug", "venues"]);
    expect(p.logoUrl).toBeNull();
    expect(p.colors).toEqual({ primary: "#aabbcc", accent: null });
    expect(JSON.stringify(p)).not.toMatch(/secret@|owner@|commission|pro/);
    expect(isLogoUrl("https://x.supabase.co/storage/v1/object/public/media/orgs/a.png")).toBe(true);
    expect(isLogoUrl("http://evil.example/a.png")).toBe(false);
  });
  it("a tournament without its own colours or logo takes its organisation's", () => {
    const org = { id: "o", slug: "club", name: "Club", colors: { primary: "#112233", accent: "#445566" }, logo_url: "https://cdn.example/logo.png" };
    const bare = toSkin({ app_skin: null, branding_config: null } as never, org);
    expect(bare.seedA).toBe("#112233");
    expect(bare.seedB).toBe("#445566");
    expect(bare.logoUrl).toContain("cdn.example/logo.png");
    const own = toSkin({ app_skin: { seedA: "#000000" }, branding_config: null } as never, org);
    expect(own.seedA).toBe("#000000");
    expect(own.seedB).toBeNull();
    expect(orgSkinDefaults(null)).toEqual({ seedA: null, seedB: null, logoUrl: null });
    expect(toSkin({ app_skin: null, branding_config: null } as never).seedA).toBeNull();
  });
  it("the app can follow an organisation", () => {
    expect(FOLLOW_KINDS).toContain("organization");
  });
});
