import { NextResponse } from "next/server";
import { can, currentRole } from "@/lib/auth";
import { getMatch, getSnapshot } from "@/lib/data";
import { getLease, isLeaseLive } from "@/lib/scoringControl";
import { isViewersDevice, presentedDeviceId, shownDeviceId, verifyInstallToken } from "@/lib/mobile/identity";

/**
 * Read-only match state for live viewers, reconnecting screens, and — since
 * the scoring-control handoff — the referee page's own poll: this is what a
 * read-only device uses both to keep its scoreboard current (it used to be
 * frozen at whatever loaded on page-open) and to notice a lease change (an
 * incoming request, an accepted/declined answer, or a stale lease going free).
 *
 * Device ids are public here only as handles (see shownDeviceId): the app
 * phone sends its install token and sees its own id; a signed-in web console
 * sees browser ids, which is what it compares against. `heldByYou` and
 * `requestedByYou` say the same for a console that sent its scoring device id
 * (`X-Device-Id`, the id its claims and renewals carry) or its install token.
 * The device id is what counts: a phone whose install token was missing or
 * stale used to see its own lease as another device's and give control up.
 */
export async function GET(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const [match, snapshot, lease, role] = await Promise.all([getMatch(matchId), getSnapshot(matchId), getLease(matchId), currentRole()]);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  const viewer = {
    installationId: verifyInstallToken(request.headers.get("x-install-token")),
    deviceId: presentedDeviceId(request.headers),
    staff: can(role, "score_match"),
  };
  const asked = lease?.transfer_request ?? null;
  return NextResponse.json(
    {
      match,
      snapshot,
      lease: lease
        ? {
            deviceId: shownDeviceId(lease.device_id, viewer),
            deviceLabel: lease.device_label,
            renewedAt: lease.renewed_at,
            expiresAt: lease.expires_at,
            isLive: isLeaseLive(lease, Date.now()),
            heldByYou: isViewersDevice(lease.device_id, viewer),
            transferRequest: asked ? { ...asked, deviceId: shownDeviceId(asked.deviceId, viewer) } : null,
            requestedByYou: asked ? isViewersDevice(asked.deviceId, viewer) : false,
          }
        : null,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
