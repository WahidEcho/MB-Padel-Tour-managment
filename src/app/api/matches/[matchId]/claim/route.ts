import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { getMatch } from "@/lib/data";
import { claimLease, sanitizeLabel } from "@/lib/scoringControl";

/**
 * Claims the scoring lease for a device (spec §18.4, now a renewable lease —
 * see src/lib/scoringControl.ts). Succeeds immediately whenever nobody else
 * holds a live lease; refused, with the current holder's label, when someone
 * else does. Other devices get read-only access until that lease ends or they
 * ask for it through /request-control.
 */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  // The match's own tournament decides the organisation (and an event code's
  // scope); another organisation's match gets the same 404 as a missing one.
  const gate = await staffRoute("score_match", { match: matchId });
  if (!gate.ok) return gate.response;
  const body = await request.json();
  const deviceId: string = body.deviceId;
  if (!deviceId) return NextResponse.json({ error: "deviceId required" }, { status: 400 });

  const match = await getMatch(matchId);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const result = await claimLease(matchId, match.tournament_id, deviceId, sanitizeLabel(body.deviceLabel, deviceId));
  if (!result.ok) {
    return NextResponse.json({ locked: true, controller: false, holder: result.holder }, { status: 200 });
  }
  return NextResponse.json({ locked: false, controller: true, lease: result.lease });
}
