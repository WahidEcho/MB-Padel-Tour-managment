import { NextResponse, after } from "next/server";
import { staffRoute } from "@/lib/guard";
import { getMatch } from "@/lib/data";
import { appendScoreEvents, type IncomingEvent } from "@/lib/scoring/append";
import { audit } from "@/lib/audit";

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
  const referee = gate.staff.referee ?? null;
  const out = await appendScoreEvents(match, deviceId, events, { role: gate.staff.role, defer: (task) => after(task), createdBy: referee ? `referee:${referee.id}` : null });
  // Referee PINs (migration 0035): every batch of points a named referee sent, in the audit log with their name.
  const applied = Array.isArray((out.body as { applied?: unknown }).applied) ? ((out.body as { applied: unknown[] }).applied.length) : 0;
  if (referee && applied > 0) {
    await audit({
        tournament_id: match.tournament_id,
        actor_role: gate.staff.role,
        action: "SCORE_EVENTS",
        entity_type: "match",
        entity_id: matchId,
        new_value: { applied, types: [...new Set(events.slice(0, 50).map((e) => String(e.event_type)))].slice(0, 10) },
    });
  }
  return NextResponse.json(out.body, { status: out.status });
}
