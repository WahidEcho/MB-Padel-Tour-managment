import { coachJson, coachMatch, coachNotFound, coachRoute } from "@/lib/coaches/server";

/** The match log of one of the team's own rubbers (no referee or staff names). Another team's match: 404. */
export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const gate = await coachRoute();
  if (!gate.ok) return gate.response;
  const m = await coachMatch(gate.coach, matchId);
  return m ? coachJson({ matchId, log: m.log }) : coachNotFound();
}
