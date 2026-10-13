import { audit } from "@/lib/audit";
import { privateJson } from "@/lib/mobile/http";
import { badRequest, playerCaller, settleFrom, strictBody } from "@/lib/players/http";
import { verifyPhoneCode } from "@/lib/players/phoneLink";

/**
 * POST { verificationId, code } → MPhoneVerified: the entries recorded with the
 * phone are linked, or `choose` lists the people who share it.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const caller = await playerCaller(request);
  if (caller instanceof Response) return caller;
  const body = await strictBody(request, ["verificationId", "code"]);
  if (!body) return badRequest();
  const r = await verifyPhoneCode(caller.userId, caller.token, body.verificationId, body.code, caller.ip);
  await settleFrom(started);
  if (!r.ok) return privateJson({ error: r.error, code: r.code, attemptsLeft: "attemptsLeft" in r ? r.attemptsLeft : undefined }, r.status);
  await audit({ action: "PLAYER_PHONE_VERIFIED", actor_role: "user", entity_type: "user", entity_id: caller.userId, new_value: { linked: r.linked?.linked ?? 0, choices: r.choose?.length ?? 0, via: r.confirmed } });
  return privateJson({ phone: r.phone, confirmed: r.confirmed, linked: r.linked, choose: r.choose, message: r.message });
}
