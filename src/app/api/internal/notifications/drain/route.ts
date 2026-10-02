import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { checkReceipts, drainNotifications } from "@/lib/notify/drain";

/**
 * Sends due alerts. Called right after each hook from inside the request, and by
 * a scheduler every minute as the safety net and for "starting soon" reminders:
 * a database cron job (supabase/ops/notification_cron.sql) or Vercel Cron, both
 * sending `Authorization: Bearer $CRON_SECRET`. The scheduled run also reads
 * Expo's delivery receipts for alerts sent fifteen or more minutes earlier.
 */
async function run(request: Request) {
  const want = process.env.CRON_SECRET;
  const got = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return NextResponse.json({ error: "Not allowed" }, { status: 401 });
  }
  const result = await drainNotifications(50);
  const receipts = await checkReceipts().catch((err: unknown) => {
    console.error("[push:receipts] pass failed", err);
    return { checked: 0, failed: 0 };
  });
  return NextResponse.json({ ok: true, ...result, receipts }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = run;
export const POST = run;
