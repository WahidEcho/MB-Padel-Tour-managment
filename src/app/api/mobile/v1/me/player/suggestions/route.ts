import { audit } from "@/lib/audit";
import { privateJson } from "@/lib/mobile/http";
import { badRequest, playerCaller, strictBody } from "@/lib/players/http";
import { answerSuggestion, linkSuggestions } from "@/lib/players/suggestions";

/** GET → { suggestions: MLinkSuggestion[] }: entries recorded with the account's confirmed email, and organisers' offers. */
export async function GET(request: Request) {
  const caller = await playerCaller(request);
  if (caller instanceof Response) return caller;
  const r = await linkSuggestions(caller.userId, caller.token, caller.ip);
  if (!r.ok) return privateJson({ error: r.error }, r.status);
  return privateJson({ suggestions: r.suggestions });
}

/** POST { id, accept } → { player, linked } ("That's me") or { declined: true } ("Not me"). */
export async function POST(request: Request) {
  const caller = await playerCaller(request);
  if (caller instanceof Response) return caller;
  const body = await strictBody(request, ["id", "accept"], 6000);
  if (!body || typeof body.accept !== "boolean") return badRequest();
  const r = await answerSuggestion(caller.userId, caller.token, body.id, body.accept);
  if (!r.ok) return privateJson({ error: r.error }, r.status);
  if ("declined" in r) return privateJson({ declined: true });
  await audit({ action: "PLAYER_SUGGESTION_ACCEPTED", actor_role: "user", entity_type: "user", entity_id: caller.userId, new_value: { linked: r.linked } });
  return privateJson({ player: r.player, linked: r.linked });
}
