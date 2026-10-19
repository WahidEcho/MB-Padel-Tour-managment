import { coachJson, coachNotFound, coachRoute, coachTeamView } from "@/lib/coaches/server";

/** The coach's "My team" (migration 0037): their own team only. Private, never cached. */
export async function GET() {
  const gate = await coachRoute();
  if (!gate.ok) return gate.response;
  const view = await coachTeamView(gate.coach);
  return view ? coachJson(view) : coachNotFound();
}
