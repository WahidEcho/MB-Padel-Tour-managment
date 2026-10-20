import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every table created from migration 0022 on ships with row-level security on, no
 * policy at all and no grant to the public keys (the live project's posture since
 * the gate closed on 14 Oct 2026): the server's secret key bypasses RLS, anon and
 * authenticated read nothing. A table left without RLS, or a policy or grant to
 * anon / authenticated, would be readable with the public anon key.
 */
const DIR = join(__dirname, "..", "..", "supabase", "migrations");
const FIRST_CHECKED = 22;

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql") && parseInt(f, 10) >= FIRST_CHECKED)
  .sort();

function tablesCreated(sql: string): string[] {
  return [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1].toLowerCase());
}

function hasRls(sql: string, table: string): boolean {
  const direct = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:public\\.)?"?${table}"?\\s+enable\\s+row\\s+level\\s+security`, "i");
  // Or the loop form of 0015: the name in an array fed to format('alter table %I enable row level security').
  const looped = new RegExp(`'${table}'`).test(sql) && /format\('alter table %I enable row level security'/i.test(sql);
  return direct.test(sql) || looped;
}

describe("new tables ship with row-level security", () => {
  it("0022's tables are closed like live: no policy, grants revoked", () => {
    const sql = readFileSync(join(DIR, files.find((f) => f.startsWith("0022_"))!), "utf8").replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/to\s+anon/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+match_calls,\s*live_activity_start_tokens,\s*live_activity_starts\s+from\s+anon,\s*authenticated/i);
  });

  it("0039's venue_maps is closed like live: RLS on, grants revoked", () => {
    const sql = readFileSync(join(DIR, files.find((f) => f.startsWith("0039_"))!), "utf8").replace(/--.*$/gm, "");
    expect(sql).toMatch(/alter\s+table\s+venue_maps\s+enable\s+row\s+level\s+security/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+venue_maps\s+from\s+anon,\s*authenticated/i);
  });

  it("finds migration 0022", () => {
    expect(files.some((f) => f.startsWith("0022_"))).toBe(true);
  });

  for (const f of files) {
    const sql = readFileSync(join(DIR, f), "utf8").replace(/--.*$/gm, "");
    for (const table of tablesCreated(sql)) {
      it(`${f} › ${table} enables row level security`, () => {
        expect(hasRls(sql, table), `${table} in ${f} has no "enable row level security"`).toBe(true);
      });
    }
    it(`${f} creates no policy`, () => {
      const names = [...sql.matchAll(/create\s+policy\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1]);
      expect(names).toEqual([]);
    });
    it(`${f} grants nothing to anon or authenticated`, () => {
      const grants = [...sql.matchAll(/\bgrant\s+[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/gi)].map((m) => m[0]);
      expect(grants).toEqual([]);
    });
  }
});
