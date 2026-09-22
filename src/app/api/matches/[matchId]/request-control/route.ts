import { NextResponse } from "next/server";
import { currentRole, can } from "@/lib/auth";
import { requestTransfer, sanitizeLabel } from "@/lib/scoringControl";

/** A read-only device asks the current holder for control. Last request wins — no queue of several pending asks. */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const role = await currentRole();
  if (!can(role, "score_match")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const { matchId } = await params;
  const body = await request.json();
  const deviceId: string = body.deviceId;
  if (!deviceId) return NextResponse.json({ error: "deviceId required" }, { status: 400 });

  const result = await requestTransfer(matchId, deviceId, sanitizeLabel(body.deviceLabel, deviceId));
  if (!result.ok) {
    const message =
      result.reason === "no_live_lease"
        ? "Nobody is currently holding this match — claim it instead."
        : "You already hold this match.";
    return NextResponse.json({ ok: false, message }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
