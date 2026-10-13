import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { requestTransfer, sanitizeLabel } from "@/lib/scoringControl";

/** A read-only device asks the current holder for control. Last request wins — no queue of several pending asks. */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  // The match's own tournament decides the organisation (and an event code's
  // scope); another organisation's match gets the same 404 as a missing one.
  const gate = await staffRoute("score_match", { match: matchId });
  if (!gate.ok) return gate.response;
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
