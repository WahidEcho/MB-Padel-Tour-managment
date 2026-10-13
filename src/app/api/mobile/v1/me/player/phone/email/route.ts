import { audit } from "@/lib/audit";
import { privateJson } from "@/lib/mobile/http";
import { badRequest, playerCaller, settleFrom, strictBody } from "@/lib/players/http";
import { emailPhoneCode } from "@/lib/players/phoneLink";

/**
 * POST { verificationId } → { ok, expiresAt }. Only after the app asked the player
 * ("Send the code by email instead?"): a new code goes to the email address the
 * organisers have for that phone. The answer never says whether one was on file.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const caller = await playerCaller(request);
  if (caller instanceof Response) return caller;
  const body = await strictBody(request, ["verificationId", "consent"]);
  if (!body || body.consent !== true) return badRequest();
  const r = await emailPhoneCode(caller.userId, body.verificationId, caller.ip);
  await settleFrom(started, 500);
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  await audit({ action: "PLAYER_PHONE_CODE_EMAILED", actor_role: "user", entity_type: "user", entity_id: caller.userId, new_value: { consent: true } });
  return privateJson({ ok: true, expiresAt: r.expiresAt, message: "If the tournament has an email address for this number, the code is on its way. Check your inbox." });
}
