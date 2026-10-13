/**
 * What the app's player-linking routes share: a signed-in account, the player
 * codes feature switched on, small JSON bodies with known fields only, and a
 * fixed minimum answer time where timing could hint at someone else's data.
 */
import { clientIpFrom } from "../ratelimit";
import { bearerOf } from "../auth/accounts";
import { ownerOf } from "../mobile/identity";
import { privateJson } from "../mobile/http";
import { getConfig } from "../mobile/server";

export interface PlayerCaller {
  userId: string;
  token: string;
  ip: string;
}

/** The caller, or the response to send instead (feature off, not signed in). */
export async function playerCaller(request: Request): Promise<PlayerCaller | Response> {
  const config = await getConfig();
  if (!config.flags.player_claim) return privateJson({ error: "Player profiles are not open yet." }, 403);
  const { owner } = await ownerOf(request);
  const token = bearerOf(request);
  if (owner?.kind !== "user" || !token) return privateJson({ error: "Sign in first." }, 401);
  return { userId: owner.id, token, ip: clientIpFrom(request.headers) };
}

/**
 * The JSON body when it is an object of at most `maxBytes` with only `keys`;
 * null otherwise (the route answers 400).
 */
export async function strictBody(request: Request, keys: string[], maxBytes = 2000): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => "");
  if (!text || text.length > maxBytes) return null;
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (Object.keys(body).some((k) => !keys.includes(k))) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const badRequest = () => privateJson({ error: "That request isn't one this server understands." }, 400);

/** Every answer takes at least `ms`, so timing says nothing. */
export async function settleFrom(started: number, ms = 350) {
  const left = ms - (Date.now() - started);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}
