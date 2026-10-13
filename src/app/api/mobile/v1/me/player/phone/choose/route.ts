import { audit } from "@/lib/audit";
import { privateJson } from "@/lib/mobile/http";
import { badRequest, playerCaller, strictBody } from "@/lib/players/http";
import { choosePhonePerson } from "@/lib/players/phoneLink";

/** POST { verificationId, choiceId } → MPhoneVerified: the player picked who they are among the people on their phone. */
export async function POST(request: Request) {
  const caller = await playerCaller(request);
  if (caller instanceof Response) return caller;
  const body = await strictBody(request, ["verificationId", "choiceId"]);
  if (!body) return badRequest();
  const r = await choosePhonePerson(caller.userId, caller.token, body.verificationId, body.choiceId);
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  await audit({ action: "PLAYER_PHONE_LINKED", actor_role: "user", entity_type: "user", entity_id: caller.userId, new_value: { linked: r.linked?.linked ?? 0, via: r.confirmed } });
  return privateJson({ phone: r.phone, confirmed: r.confirmed, linked: r.linked, choose: r.choose, message: r.message });
}
