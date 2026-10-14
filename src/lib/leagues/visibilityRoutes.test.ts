import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * League visibility (migration 0031) on the routes: a shared, CDN-cached answer
 * never depends on who asks, and a per-user answer is never cacheable. Behaviour
 * against real rows: scripts/e2e/leagues.ts (section 10) and organizations.ts.
 */
const API = join(__dirname, "..", "..", "app", "api", "mobile", "v1");
const read = (...p: string[]) => readFileSync(join(API, ...p), "utf8");
const lib = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

const PUBLIC_ROUTES = [
  ["leagues", "[slug]", "route.ts"],
  ["leagues", "top", "route.ts"],
  ["orgs", "[slug]", "route.ts"],
  ["t", "[slug]", "bundle", "route.ts"],
  ["t", "[slug]", "live", "route.ts"],
  ["t", "[slug]", "standings", "route.ts"],
  ["courts", "live", "route.ts"],
];

const PER_USER_ROUTES = [
  ["me", "leagues", "route.ts"],
  ["me", "leagues", "[slug]", "route.ts"],
  ["leagues", "code", "route.ts"],
  ["leagues", "[slug]", "join", "route.ts"],
  ["me", "t", "[slug]", "bundle", "route.ts"],
  ["me", "t", "[slug]", "live", "route.ts"],
  ["me", "t", "[slug]", "standings", "route.ts"],
  ["me", "widget", "route.ts"],
];

describe("shared routes never read who is asking", () => {
  for (const p of PUBLIC_ROUTES) {
    it(p.join("/"), () => {
      const src = read(...p);
      expect(src).not.toMatch(/ownerOf|headers\(\)|cookies\(\)|authorization/i);
    });
  }
});

describe("per-user routes are never cacheable", () => {
  for (const p of PER_USER_ROUTES) {
    it(p.join("/"), () => {
      const src = read(...p);
      expect(src).toMatch(/ownerOf/);
      expect(src).not.toMatch(/publicJson|notFoundJson|s-maxage/);
      for (const m of src.matchAll(/"Cache-Control":\s*"([^"]+)"/g)) expect(m[1]).toBe("private, no-store");
    });
  }
});

describe("the public league reads only reach 'everyone' leagues", () => {
  const server = lib("leagues", "server.ts");
  it("the shared league page refuses any other visibility", () => {
    const fn = server.slice(server.indexOf("export async function getPublicLeague"), server.indexOf("export async function getLeagueForUser"));
    expect(fn).toMatch(/isPublicVisibility\(found\.league\.visibility\)/);
  });
  it("league cards filter to 'everyone' unless the caller decided per account", () => {
    const fn = server.slice(server.indexOf("export async function leagueCards"), server.indexOf("function scoreLine"));
    expect(fn).toMatch(/if \(!filter\.restricted\) q = q\.eq\("visibility", "everyone"\)/);
  });
  it("top boards count 'everyone' leagues only", () => {
    const fn = server.slice(server.indexOf("async function topLeagues"), server.indexOf("async function approvedOrgs"));
    expect(fn).toMatch(/\.eq\("visibility", "everyone"\)/);
    expect(lib("mobile", "orgs.ts")).toMatch(/\.eq\("counts_toward_top_of_all", true\)\s*\.eq\("visibility", "everyone"\)/);
  });
  it("the shared session reads (bundle, live, hero) let only public league sessions through", () => {
    const fn = server.slice(server.indexOf("export async function isPublicLeagueSession"), server.indexOf("export async function leagueSessionVisibleTo"));
    expect(fn).toMatch(/isPublicVisibility\(league!\.visibility\)/);
    expect(lib("mobile", "courts.ts")).toMatch(/isPublicLeagueSession\(r\.id\)/);
  });
  it("joining refuses a league the account may not see with the missing-league 404", () => {
    const fn = server.slice(server.indexOf("export async function joinLeague"));
    expect(fn.slice(0, 600)).toMatch(/userCanSeeLeague\(found\.league, input\.userId\)\)\) return \{ ok: false, status: 404/);
  });
});
