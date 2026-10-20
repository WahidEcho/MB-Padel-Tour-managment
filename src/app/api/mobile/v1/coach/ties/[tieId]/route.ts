import { coachJson, coachNotFound, coachRoute, coachTie } from "@/lib/coaches/server";

/** One of the coach's own ties; another team's tie answers like a missing one (404). */
export async function GET(_request: Request, { params }: { params: Promise<{ tieId: string }> }) {
  const { tieId } = await params;
  const gate = await coachRoute();
  if (!gate.ok) return gate.response;
  const tie = await coachTie(gate.coach, tieId);
  return tie ? coachJson(tie) : coachNotFound();
}
