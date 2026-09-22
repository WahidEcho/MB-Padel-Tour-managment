import { NextResponse } from "next/server";
import { getMatch, getSnapshot } from "@/lib/data";
import { getLease, isLeaseLive } from "@/lib/scoringControl";

/**
 * Read-only match state for live viewers, reconnecting screens, and — since
 * the scoring-control handoff — the referee page's own poll: this is what a
 * read-only device uses both to keep its scoreboard current (it used to be
 * frozen at whatever loaded on page-open) and to notice a lease change (an
 * incoming request, an accepted/declined answer, or a stale lease going free).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const [match, snapshot, lease] = await Promise.all([getMatch(matchId), getSnapshot(matchId), getLease(matchId)]);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  return NextResponse.json({
    match,
    snapshot,
    lease: lease
      ? {
          deviceId: lease.device_id,
          deviceLabel: lease.device_label,
          renewedAt: lease.renewed_at,
          expiresAt: lease.expires_at,
          isLive: isLeaseLive(lease, Date.now()),
          transferRequest: lease.transfer_request,
        }
      : null,
  });
}
