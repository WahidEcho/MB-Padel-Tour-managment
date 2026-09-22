import { NextResponse } from "next/server";
import { currentRole, can } from "@/lib/auth";
import { releaseLease } from "@/lib/scoringControl";

/** The holder gives control up on purpose — a clean handover at a changeover, without waiting out the lease's TTL. */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const role = await currentRole();
  if (!can(role, "score_match")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const { matchId } = await params;
  const { deviceId } = await request.json();
  if (!deviceId) return NextResponse.json({ error: "deviceId required" }, { status: 400 });

  const result = await releaseLease(matchId, deviceId);
  return NextResponse.json({ ok: result.ok });
}
