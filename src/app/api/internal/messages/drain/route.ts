import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/safeEqual";
import { drainMessages } from "@/lib/messaging/queue";
import { securePlayerCodes } from "@/lib/players/codeVault";
import { pruneVerifications } from "@/lib/players/phoneLink";
import { archiveFinishedEvents, expireStalePayments, expireUnconfirmed } from "@/lib/registration/server";
import { sweepExpiredStories } from "@/lib/stories/server";

/** Long announcements are sent in time-boxed chunks; one call sends for up to ~40 s. */
export const maxDuration = 60;

/**
 * Sends queued emails and WhatsApp messages. Called every minute by the database
 * cron job (supabase/ops/messaging_cron.sql) with `Authorization: Bearer
 * $CRON_SECRET`, as the safety net behind the admin page's own progress loop.
 *
 * Housekeeping on the same beat: player codes still stored in clear (new players
 * take the column default) are hashed and sealed (src/lib/players/codeVault.ts),
 * and phone verifications older than a day are deleted. Registration (Phase 9):
 * the player links of events that ended more than 24 hours ago are archived
 * (player_claims.archived_at), Move Tick checkouts that expired unanswered
 * are marked expired, XPay checkouts whose 15-minute hold ended are closed at XPay, and web guests who never opened their emailed link within
 * 24 hours are cancelled. Move Score Stories older than 24 hours are deleted with their
 * pictures (src/lib/stories/server.ts).
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
  let claimsArchived = 0;
  try {
    claimsArchived = await archiveFinishedEvents();
    await expireStalePayments();
    await expireUnconfirmed();
  } catch (err) {
    console.error("[housekeeping] registrations", err);
  }
  let storiesSwept = 0;
  try {
    storiesSwept = await sweepExpiredStories();
  } catch (err) {
    console.error("[housekeeping] stories", err);
  }
  return NextResponse.json({ ok: true, ...result, codesHashed, claimsArchived, storiesSwept }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = run;
export const POST = run;
