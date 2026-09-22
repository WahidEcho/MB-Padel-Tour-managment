import { NextResponse } from "next/server";
import { currentRole, can } from "@/lib/auth";
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
  const role = await currentRole();
  if (!can(role, "score_match")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const { matchId } = await params;
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
