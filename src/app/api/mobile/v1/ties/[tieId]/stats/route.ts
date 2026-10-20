import { getTieStats, statsCacheSeconds } from "@/lib/mobile/stats";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/** A tie's stats: its rubbers summed per nation, plus the time on court. Public tournaments only. */
export async function GET(_request: Request, { params }: { params: Promise<{ tieId: string }> }) {
  const { tieId } = await params;
  const s = await getTieStats(tieId);
  if (!s) return notFoundJson("Tie not found");
  const [maxAge, swr] = statsCacheSeconds(s.status);
  return publicJson(s, maxAge, swr);
}
