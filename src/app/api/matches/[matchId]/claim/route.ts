import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { currentRole, can } from "@/lib/auth";
import { getMatch } from "@/lib/data";

/**
 * Claims the scoring lock for a device: one active scoring device per match
 * (spec §18.4). Other devices get read-only access.
 */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const role = await currentRole();
  if (!can(role, "score_match")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const { matchId } = await params;
  const { deviceId } = await request.json();
  if (!deviceId) return NextResponse.json({ error: "deviceId required" }, { status: 400 });

  const match = await getMatch(matchId);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  if (match.active_scoring_device_id && match.active_scoring_device_id !== deviceId) {
    return NextResponse.json({ locked: true, controller: false }, { status: 200 });
  }
  if (!match.active_scoring_device_id) {
    await db()
      .from("matches")
      .update({ active_scoring_device_id: deviceId })
      .eq("id", matchId)
      .is("active_scoring_device_id", null);
    // Re-read in case of a race: last writer check
    const fresh = await getMatch(matchId);
    if (fresh?.active_scoring_device_id !== deviceId) {
      return NextResponse.json({ locked: true, controller: false }, { status: 200 });
    }
  }
  return NextResponse.json({ locked: false, controller: true });
}
