import { getTimeline } from "@/lib/mobile/server";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/** Point by point, for the momentum chart and the game feed. */
export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const t = await getTimeline(matchId);
  return t ? publicJson(t, 5, 30) : notFoundJson("Match not found");
}
