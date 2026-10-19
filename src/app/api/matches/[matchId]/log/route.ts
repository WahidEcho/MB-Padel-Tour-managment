import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { getMatch, getTournament } from "@/lib/data";
import { matchDayRules } from "@/lib/matchday/rules";
import { loadMatchLog } from "@/lib/scoring/matchLogServer";

/**
 * Scoring v2: the match log (every event in order, in words) for the referee
 * scoring it, the master referees and the organiser's staff. A referee sees it
 * only while the organiser has "Match log for referees" on; admins and managers
 * always do.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const gate = await staffRoute("score_match", { match: matchId });
  if (!gate.ok) return gate.response;
  const match = await getMatch(matchId);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  const organiser = gate.staff.role === "admin" || gate.staff.role === "manager";
  if (!organiser) {
    const t = await getTournament(match.tournament_id);
    if (!matchDayRules(t?.match_day_rules, t ?? undefined).features.matchLog) {
      return NextResponse.json({ error: "The organiser has not turned the match log on for referees.", code: "feature_off" }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
    }
  }
  const log = await loadMatchLog(matchId);
  if (!log) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  return NextResponse.json(log, { headers: { "Cache-Control": "private, no-store" } });
}
