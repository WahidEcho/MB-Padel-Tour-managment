import { after } from "next/server";
import { audit } from "@/lib/audit";
import { privateJson } from "@/lib/mobile/http";
import { badRequest, playerCaller, settleFrom, strictBody } from "@/lib/players/http";
import { emailPhoneCode } from "@/lib/players/phoneLink";

/**
 * POST { verificationId, consent: true } → { ok, expiresAt, to, message }. Only after
 * the app asked the player ("Send the code by email instead?"): a new code goes to
 * the account's own confirmed email, if an organiser recorded that address with
 * this phone. The answer never says whether it was on file, and the email is sent
 * after the answer, so its timing says nothing either.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const caller = await playerCaller(request);
  if (caller instanceof Response) return caller;
  const body = await strictBody(request, ["verificationId", "consent"]);
  if (!body || body.consent !== true) return badRequest();
  const r = await emailPhoneCode(caller.userId, caller.token, body.verificationId, caller.ip);
  if (r.ok && r.send) {
    const send = r.send;
    after(async () => {
      await send().catch((e) => console.error("[phone-code] email send failed", e instanceof Error ? e.message : e));
    });
  }
  await settleFrom(started, 500);
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  await audit({ action: "PLAYER_PHONE_CODE_EMAILED", actor_role: "user", entity_type: "user", entity_id: caller.userId, new_value: { consent: true } });
  return privateJson({
    ok: true,
    expiresAt: r.expiresAt,
    to: r.to,
    message: `If the tournament recorded ${r.to} with this number, the code is on its way to that address. Check your inbox.`,
  });
}
