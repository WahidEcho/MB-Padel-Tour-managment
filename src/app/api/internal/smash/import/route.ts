import { NextResponse, after } from "next/server";
import { safeEqual } from "@/lib/auth/safeEqual";
import { smashImportSwitch } from "@/lib/smash/plan";
import { runSmashImport } from "@/lib/smash/server";

/** At most 6 results, 3 s apart, plus the Smash fetch (8 s timeout). */
export const maxDuration = 60;

/**
 * Copies finished results from Smash Sporting Club's public scores feed into the two Cairo events
 * (src/lib/smash/server.ts). Called every 2 minutes by the database cron job
 * (supabase/ops/smash_import_cron.sql) with `Authorization: Bearer $CRON_SECRET`, the same secret as
 * the messages drain. Does nothing unless SMASH_IMPORT_ON=1, and nothing after 8 Nov 2026 21:00
 * Cairo (SMASH_IMPORT_UNTIL overrides the end). Never courts 13 and 14; never a rubber with a score.
 */
export async function POST(request: Request) {
  const want = process.env.CRON_SECRET;
  const got = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || !safeEqual(got, want)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 401 });
  }
  const headers = { "Cache-Control": "no-store" };
  const sw = smashImportSwitch({ SMASH_IMPORT_ON: process.env.SMASH_IMPORT_ON, SMASH_IMPORT_UNTIL: process.env.SMASH_IMPORT_UNTIL }, new Date());
  if (!sw.on) return NextResponse.json({ off: true, reason: sw.reason }, { headers });
  try {
    const summary = await runSmashImport({ defer: (task) => after(task) });
    if (summary.entered.length) {
      console.log(`[smash-import] entered ${summary.entered.length}, desk ${summary.desk.length}, waiting ${summary.waiting}`);
    }
    return NextResponse.json(summary, { headers });
  } catch (err) {
    console.error("[smash-import]", err);
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500, headers });
  }
}
