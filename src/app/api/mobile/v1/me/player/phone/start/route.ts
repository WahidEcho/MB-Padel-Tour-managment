import { audit } from "@/lib/audit";
import { privateJson } from "@/lib/mobile/http";
import { badRequest, playerCaller, settleFrom, strictBody } from "@/lib/players/http";
import { startPhoneVerification } from "@/lib/players/phoneLink";

/**
 * POST { phone } → MPhoneStart. Sends a six-digit code to the phone on WhatsApp.
 * The same answer whether or not any tournament has that number; `sent: false`
 * means WhatsApp did not take it, and the app asks before trying email.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const caller = await playerCaller(request);
  if (caller instanceof Response) return caller;
  const body = await strictBody(request, ["phone"]);
  if (!body) return badRequest();
  const r = await startPhoneVerification(caller.userId, body.phone, caller.ip);
  await settleFrom(started);
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  await audit({ action: "PLAYER_PHONE_CODE_SENT", actor_role: "user", entity_type: "user", entity_id: caller.userId, new_value: { channel: "whatsapp", sent: r.sent } });
  return privateJson({ verificationId: r.verificationId, phone: r.phone, channel: r.channel, sent: r.sent, expiresAt: r.expiresAt });
}
