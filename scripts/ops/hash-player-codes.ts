/**
 * One-off backfill after migration 0024: hashes and seals every player code still
 * stored in clear (players.access_code), then clears the plain column. Safe to run
 * again; the messaging cron does the same for new players every minute.
 *
 *   PLAYER_CODE_PEPPER=<the production value> \
 *   SUPABASE_URL=… SUPABASE_KEY=<secret key> \
 *   npx tsx scripts/ops/hash-player-codes.ts [--dry-run]
 *
 * It must run with the SAME PLAYER_CODE_PEPPER as the deployed server, or no code
 * will work afterwards (reset them all to recover). Prints counts only, never a code.
 */
import { db } from "../../src/lib/supabase";
import { playerCodePepper, securePlayerCodes } from "../../src/lib/players/codeVault";

async function main() {
  if (!process.env.PLAYER_CODE_PEPPER || process.env.PLAYER_CODE_PEPPER.length < 32) {
    console.error("PLAYER_CODE_PEPPER (32+ characters, the production value) must be set.");
    process.exit(1);
  }
  playerCodePepper(); // throws if unusable
  const count = async (plain: boolean): Promise<number> => {
    const { count: n } = await db()
      .from("players")
      .select("id", { count: "exact", head: true })
      .not(plain ? "access_code" : "access_code_hash", "is", null);
    return n ?? 0;
  };
  const before = await count(true);
  console.log(`Plain codes: ${before}; hashed already: ${await count(false)}`);
  if (process.argv.includes("--dry-run") || !before) return;
  let total = 0;
  for (;;) {
    const n = await securePlayerCodes({ limit: 1000 });
    total += n;
    console.log(`  hashed ${total}`);
    if (n === 0) break;
  }
  console.log(`Done. Plain codes left: ${await count(true)} (a row left plain was logged as a hash clash: reset its code).`);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
