import { NextResponse } from "next/server";
import { currentRole, can } from "@/lib/auth";
import { renewLease } from "@/lib/scoringControl";

/**
 * The controlling device's heartbeat. Called every `LEASE_RENEW_MS` while a
 * device holds a match's lease; three missed calls (`LEASE_TTL_MS`) and the
 * lease goes stale on its own, so the next device to claim just takes it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const role = await currentRole();
  if (!can(role, "score_match")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const { matchId } = await params;
  const { deviceId } = await request.json();
  if (!deviceId) return NextResponse.json({ error: "deviceId required" }, { status: 400 });

  const result = await renewLease(matchId, deviceId);
  if (!result.ok) {
    return NextResponse.json({ renewed: false, reason: result.reason }, { status: 200 });
  }
  return NextResponse.json({ renewed: true, expiresAt: result.lease.expires_at });
}
