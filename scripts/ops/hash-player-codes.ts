/**
 * One-off backfill after migration 0024: hashes and seals every player code still
 * stored in clear (players.access_code), then clears the plain column, and then
 * removes the codes older code left in the message log (scrub-delivery-codes.ts).
 * Safe to run again; the messaging cron hashes new players every minute.
 *
 *   PLAYER_CODE_PEPPER=<the production value> \
 *   SUPABASE_URL=… SUPABASE_KEY=<secret key> \
 *   npx tsx scripts/ops/hash-player-codes.ts [--dry-run] [--first-run]
 *
 * It must run with the SAME PLAYER_CODE_PEPPER as the deployed server, or no code
 * would work afterwards. So before writing anything it opens a row the server has
 * already sealed and checks the pepper reproduces that row's hash; it refuses when
 * it does not. When no row is sealed yet (the very first run, before the deployed
 * server has hashed anything), it refuses unless `--first-run` says so on purpose.
 * Prints counts only, never a code.
 */
import { db } from "../../src/lib/supabase";
import { hashPlayerCode, openPlayerCode, playerCodePepper, securePlayerCodes } from "../../src/lib/players/codeVault";
import { describe, scrubDeliveryCodes } from "./scrub-delivery-codes";

/** "ok" when the pepper opens a sealed row and reproduces its hash; "none" when nothing is sealed yet; "wrong" otherwise. */
export async function checkPepper(pepper: string): Promise<"ok" | "none" | "wrong"> {
  const { data, error } = await db().from("players").select("access_code_hash, access_code_sealed").not("access_code_sealed", "is", null).not("access_code_hash", "is", null).limit(5);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { access_code_hash: string; access_code_sealed: string }[];
  if (!rows.length) return "none";
  // One good row is enough; every row must not be a mismatch either (a mixed table means two peppers).
  let good = 0;
  for (const r of rows) {
    const code = openPlayerCode(r.access_code_sealed, pepper);
    if (code && hashPlayerCode(code, pepper) === r.access_code_hash) good++;
  }
  return good === rows.length ? "ok" : "wrong";
}

async function main() {
  const pepper = process.env.PLAYER_CODE_PEPPER;
  if (!pepper || pepper.length < 32) {
    console.error("PLAYER_CODE_PEPPER (32+ characters, the production value) must be set.");
    process.exit(1);
  }
  playerCodePepper(); // throws if unusable
  const dryRun = process.argv.includes("--dry-run");
  const verdict = await checkPepper(pepper);
  if (verdict === "wrong") {
    console.error("PLAYER_CODE_PEPPER does not open the codes already sealed in this database: it is not the deployed server's pepper. Nothing was written.");
    process.exit(1);
  }
  if (verdict === "none" && !process.argv.includes("--first-run")) {
    console.error("No sealed code to check the pepper against yet. If this is the first run, check PLAYER_CODE_PEPPER is the deployed server's and pass --first-run. Nothing was written.");
    process.exit(1);
  }
  console.log(verdict === "ok" ? "Pepper checked against codes the server already sealed." : "First run: no sealed code to check the pepper against (--first-run).");
  const count = async (plain: boolean): Promise<number> => {
    const { count: n } = await db()
      .from("players")
      .select("id", { count: "exact", head: true })
      .not(plain ? "access_code" : "access_code_hash", "is", null);
    return n ?? 0;
  };
  const before = await count(true);
  console.log(`Plain codes: ${before}; hashed already: ${await count(false)}`);
  if (!dryRun && before) {
    let total = 0;
    for (;;) {
      const n = await securePlayerCodes({ limit: 1000 });
      total += n;
      console.log(`  hashed ${total}`);
      if (n === 0) break;
    }
    console.log(`Plain codes left: ${await count(true)} (a row left plain was logged as a hash clash: reset its code).`);
  }
  // The message log: codes older code stored there in clear.
  console.log(describe(await scrubDeliveryCodes({ dryRun }), dryRun, "run without --dry-run to write"));
}

if (process.argv[1]?.endsWith("hash-player-codes.ts")) {
  void main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
