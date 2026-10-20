import { getMatchStats, statsCacheSeconds } from "@/lib/mobile/stats";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/** A match's stats for fans (aces only when the organiser shows them). Public tournaments only, like the match detail. */
export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const s = await getMatchStats(matchId);
  if (!s) return notFoundJson("Match not found");
  const [maxAge, swr] = statsCacheSeconds(s.status);
  return publicJson(s, maxAge, swr);
}
