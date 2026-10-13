import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every table created from migration 0022 on ships with row-level security on and
 * no policy but server_full_access (the one supabase/gate/close_open_access.sql
 * drops). A table left without RLS would be readable with the public anon key.
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
    it(`${f} creates no policy but server_full_access`, () => {
      const names = [...sql.matchAll(/create\s+policy\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1]);
      expect(names.filter((n) => n !== "server_full_access")).toEqual([]);
    });
  }
});
