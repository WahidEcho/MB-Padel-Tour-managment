import { NextResponse } from "next/server";
import { getMatch, getSnapshot } from "@/lib/data";

/** Public read-only state for live viewers and reconnecting screens. */
export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const [match, snapshot] = await Promise.all([getMatch(matchId), getSnapshot(matchId)]);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  return NextResponse.json({ match, snapshot });
}
