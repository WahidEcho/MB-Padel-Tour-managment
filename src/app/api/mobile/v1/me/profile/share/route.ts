import { audit } from "@/lib/audit";
import { privateJson } from "@/lib/mobile/http";
import { badRequest, playerCaller, strictBody } from "@/lib/players/http";
import { shareWithOrg } from "@/lib/players/link";
import { loadMyProfile } from "@/lib/players/profile";

/**
 * POST { organizationId } → { profile }: the player shares their contact details
 * with an organisation that only matched them by a number typed on its form
 * (organization_players.source becomes 'link'). "Not found" for an organisation
 * that is not theirs, or not one that can be shared with.
 */
export async function POST(request: Request) {
  const caller = await playerCaller(request);
  if (caller instanceof Response) return caller;
  const body = await strictBody(request, ["organizationId"]);
  if (!body || typeof body.organizationId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.organizationId)) return badRequest();
  if (!(await shareWithOrg(caller.userId, body.organizationId))) return privateJson({ error: "Not found" }, 404);
  await audit({ action: "PLAYER_SHARED_WITH_ORG", actor_role: "user", entity_type: "user", entity_id: caller.userId, new_value: { organization: body.organizationId } });
  return privateJson({ profile: await loadMyProfile(caller.userId) });
}
