import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * supabase/gate/reopen_open_access.sql is the rollback for closing the database's
 * open door. It must never hand the anon key the private tables (event-code
 * hashes, members, platform admins, organisations' players), and every table a
 * migration from 0023 on creates must be classified there, so a private table
 * added later cannot be reopened by default.
 */
const ROOT = join(__dirname, "..", "..");
const reopen = readFileSync(join(ROOT, "supabase/gate/reopen_open_access.sql"), "utf8");
const migrationsDir = join(ROOT, "supabase/migrations");

/** The tables in the script's private_tables array. */
function privateTables(sql: string): string[] {
  const m = /private_tables\s+constant\s+text\[\]\s*:=\s*array\[([^\]]*)\]/i.exec(sql);
  if (!m) return [];
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

/** Tables created by migrations numbered `from` and up. */
function tablesCreatedFrom(from: number): { table: string; file: string }[] {
  return readdirSync(migrationsDir)
    .filter((f) => parseInt(f, 10) >= from)
    .flatMap((file) =>
      [...readFileSync(join(migrationsDir, file), "utf8").matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_]+)/gi)].map((m) => ({ table: m[1].toLowerCase(), file })),
    );
}

const MUST_STAY_CLOSED = ["organizations", "organization_members", "organization_codes", "platform_admins", "organization_players", "organization_invites", "rls_canary"];

/** Tables from 0023 on that may be reopened (none yet): table → why it holds nothing private. */
const REOPEN_OK: Record<string, string> = {};

describe("the open-access rollback never reopens private tables", () => {
  const list = privateTables(reopen);

  it("names its private tables", () => {
    for (const t of MUST_STAY_CLOSED) expect(list, `${t} must be in reopen_open_access.sql's private_tables`).toContain(t);
  });

  it("every table created from migration 0023 on is classified", () => {
    for (const { table, file } of tablesCreatedFrom(23)) {
      expect(list.includes(table) || Boolean(REOPEN_OK[table]), `${file} creates ${table}: add it to private_tables in reopen_open_access.sql (or REOPEN_OK here, with a reason)`).toBe(true);
    }
  });

  it("the policy loop skips them", () => {
    expect(reopen).toMatch(/not \(tablename = any \(private_tables\)\)/);
  });

  it("and they are re-revoked after the blanket grant", () => {
    const grant = reopen.indexOf("grant all on all tables in schema public to anon, authenticated");
    const revoke = reopen.indexOf("revoke all on %I from anon, authenticated");
    expect(grant).toBeGreaterThan(-1);
    expect(revoke, "the private tables must be revoked again after the grant").toBeGreaterThan(grant);
    expect(reopen.slice(revoke - 400, revoke)).toMatch(/foreach t in array private_tables/);
  });

  it("every new table ships with row-level security on", () => {
    for (const file of readdirSync(migrationsDir).filter((f) => parseInt(f, 10) >= 23)) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_]+)/gi)) {
        expect(sql, `${file}: ${m[1]} needs "alter table ${m[1]} enable row level security"`).toMatch(new RegExp(`alter table ${m[1]} enable row level security`));
      }
    }
  });
});
