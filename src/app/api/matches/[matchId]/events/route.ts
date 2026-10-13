import { NextResponse, after } from "next/server";
import { staffRoute } from "@/lib/guard";
import { getMatch } from "@/lib/data";
import { appendScoreEvents, type IncomingEvent } from "@/lib/scoring/append";

/**
 * Ordered event sync from the active scoring device (spec §18.8).
 * Idempotent on client_event_id; rejects out-of-sequence batches and
 * non-controlling devices so conflicts surface instead of corrupting state.
 * The write path itself is src/lib/scoring/append.ts (shared with the admin's
 * final-result entry); final results (RESULT_ENTERED) are rebuilt there.
 */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  // The match's own tournament decides the organisation (and an event code's
  // scope); another organisation's match gets the same 404 as a missing one.
  const gate = await staffRoute("score_match", { match: matchId });
  if (!gate.ok) return gate.response;
  const body = (await request.json().catch(() => null)) as { deviceId?: unknown; events?: unknown } | null;
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
  const events = (Array.isArray(body?.events) ? body.events : []) as IncomingEvent[];
  if (!deviceId || events.length === 0) {
    return NextResponse.json({ error: "deviceId and events required" }, { status: 400 });
  }

  const match = await getMatch(matchId);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  const out = await appendScoreEvents(match, deviceId, events, { role: gate.staff.role, defer: (task) => after(task) });
  return NextResponse.json(out.body, { status: out.status });
}
