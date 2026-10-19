import { staffRoute } from "@/lib/guard";
import { privateJson } from "@/lib/mobile/http";
import { isMasterReferee, isOrganiser } from "@/lib/referees/assistance";
import { lineupNotices } from "@/lib/tennis/lineupServer";

/**
 * The live banner of accepted line-up exceptions (last 12 hours) for the master
 * referees (their events) and the organiser (the organisation's). Staff only, never
 * cached; everyone else gets an empty list.
 */
export async function GET() {
  const gate = await staffRoute("score_match");
  if (!gate.ok) return gate.response;
  const { staff } = gate;
  const role = isMasterReferee(staff) ? "master" : isOrganiser(staff) ? "organiser" : "none";
  return privateJson({ role, notices: role === "none" ? [] : await lineupNotices(staff) });
}
