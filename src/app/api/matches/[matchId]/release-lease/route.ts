import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { releaseLease } from "@/lib/scoringControl";

/** The holder gives control up on purpose — a clean handover at a changeover, without waiting out the lease's TTL. */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  // The match's own tournament decides the organisation (and an event code's
  // scope); another organisation's match gets the same 404 as a missing one.
  const gate = await staffRoute("score_match", { match: matchId });
  if (!gate.ok) return gate.response;
  const { deviceId } = await request.json();
  if (!deviceId) return NextResponse.json({ error: "deviceId required" }, { status: 400 });

  const result = await releaseLease(matchId, deviceId);
  return NextResponse.json({ ok: result.ok });
}
