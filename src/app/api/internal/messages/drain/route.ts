import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { drainMessages } from "@/lib/messaging/queue";

/** Long announcements are sent in time-boxed chunks; one call sends for up to ~40 s. */
export const maxDuration = 60;

/**
 * Sends queued emails and WhatsApp messages. Called every minute by the database
 * cron job (supabase/ops/messaging_cron.sql) with `Authorization: Bearer
 * $CRON_SECRET`, as the safety net behind the admin page's own progress loop.
 */
async function run(request: Request) {
  const want = process.env.CRON_SECRET;
  const got = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return NextResponse.json({ error: "Not allowed" }, { status: 401 });
  }
  const result = await drainMessages({ budgetMs: 40_000 });
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = run;
export const POST = run;
