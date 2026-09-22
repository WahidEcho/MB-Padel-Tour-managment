import { NextResponse } from "next/server";
import { currentRole, can } from "@/lib/auth";
import { getMatch } from "@/lib/data";
import { respondTransfer } from "@/lib/scoringControl";
import { audit } from "@/lib/audit";

/**
 * The current holder accepts or declines a pending request. Only the device
 * named on the lease may call this — `respondTransfer` checks `deviceId`
 * against it and refuses anyone else, the same ownership rule swanlake's
 * `approveControllerTransfer`/`denyControllerTransfer` use.
 */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const role = await currentRole();
  if (!can(role, "score_match")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const { matchId } = await params;
  const body = await request.json();
  const deviceId: string = body.deviceId;
  const accept: boolean = body.accept === true;
  if (!deviceId) return NextResponse.json({ error: "deviceId required" }, { status: 400 });

  const match = await getMatch(matchId);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const result = await respondTransfer(matchId, match.tournament_id, deviceId, accept);
  if (!result.ok) {
    const message =
      result.reason === "not_holder"
        ? "You are not holding this match — nothing to answer."
        : "There is no pending request.";
    return NextResponse.json({ ok: false, message }, { status: 409 });
  }
  if (result.accepted) {
    await audit({
      tournament_id: match.tournament_id,
      actor_role: role,
      action: "SCORING_CONTROL_TRANSFERRED",
      entity_type: "match",
      entity_id: matchId,
      old_value: { device_id: deviceId },
      new_value: { device_id: result.lease.device_id, device_label: result.lease.device_label },
    });
  }
  return NextResponse.json({ ok: true, accepted: result.accepted });
}
