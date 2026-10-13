import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/safeEqual";
import { drainMessages } from "@/lib/messaging/queue";
import { securePlayerCodes } from "@/lib/players/codeVault";
import { pruneVerifications } from "@/lib/players/phoneLink";

/** Long announcements are sent in time-boxed chunks; one call sends for up to ~40 s. */
export const maxDuration = 60;

/**
 * Sends queued emails and WhatsApp messages. Called every minute by the database
 * cron job (supabase/ops/messaging_cron.sql) with `Authorization: Bearer
 * $CRON_SECRET`, as the safety net behind the admin page's own progress loop.
 *
 * Housekeeping on the same beat: player codes still stored in clear (new players
 * take the column default) are hashed and sealed (src/lib/players/codeVault.ts),
 * and phone verifications older than a day are deleted.
 */
async function run(request: Request) {
  const want = process.env.CRON_SECRET;
  const got = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || !safeEqual(got, want)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 401 });
  }
  const result = await drainMessages({ budgetMs: 40_000 });
  let codesHashed = 0;
  try {
    codesHashed = await securePlayerCodes({ limit: 300 });
    await pruneVerifications();
  } catch (err) {
    console.error("[housekeeping] player codes", err);
  }
  return NextResponse.json({ ok: true, ...result, codesHashed }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = run;
export const POST = run;
