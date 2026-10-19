import { coachJson, coachLineup, coachNotFound, coachRoute } from "@/lib/coaches/server";

/**
 * The team's own line-up for one of its ties (read only: line-ups are entered by the
 * court referee, master referee or organiser). Another team's tie: 404. Any write: 405.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ tieId: string }> }) {
  const { tieId } = await params;
  const gate = await coachRoute();
  if (!gate.ok) return gate.response;
  const lineup = await coachLineup(gate.coach, tieId);
  return lineup ? coachJson(lineup) : coachNotFound();
}
