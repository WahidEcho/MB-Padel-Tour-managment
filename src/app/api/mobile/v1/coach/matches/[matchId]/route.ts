import { coachJson, coachMatch, coachNotFound, coachRoute } from "@/lib/coaches/server";

/** One of the team's own rubbers: score and match log (no referee names). Another team's: 404. */
export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const gate = await coachRoute();
  if (!gate.ok) return gate.response;
  const m = await coachMatch(gate.coach, matchId);
  return m ? coachJson(m) : coachNotFound();
}
