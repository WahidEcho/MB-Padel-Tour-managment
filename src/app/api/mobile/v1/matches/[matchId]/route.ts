import { getMatchDetail } from "@/lib/mobile/server";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/** One match with its live score, for the match screen. */
export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const d = await getMatchDetail(matchId);
  return d ? publicJson(d, 1, 4) : notFoundJson("Match not found");
}
