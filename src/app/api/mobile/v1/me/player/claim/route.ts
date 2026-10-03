import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { clientIpFrom } from "@/lib/ratelimit";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import { getConfig } from "@/lib/mobile/server";
import { claimBlocked, claimPlayerCode } from "@/lib/players/claims";

// Every answer takes at least this long, so timing says nothing about the code.
const MIN_MS = 350;
const settle = async (started: number) => {
  const left = MIN_MS - (Date.now() - started);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
};

/**
 * POST { code } → { player: MMyPlayer, linked }. Links the signed-in account to
 * the player whose code it is (and the same person's rows in other tournaments).
 *
 * Signing in is required: the link then survives a new phone, ends with the
 * account when it is deleted, and the phone number and photo it unlocks belong
 * to a person who signed in, not to whoever holds a handset. Failed attempts are
 * limited per account, per phone and per network.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const config = await getConfig();
  if (!config.flags.player_claim) return NextResponse.json({ error: "Player codes are not open yet." }, { status: 403 });
  const { owner, installationId } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first, then enter your player code." }, { status: 401 });
  const caller = { userId: owner.id, installationId, ip: clientIpFrom(request.headers) };
  if (await claimBlocked(caller)) {
    await settle(started);
    return privateJson({ error: "Too many tries. Wait an hour, or ask the tournament desk." }, 429);
  }
  const body = await readJson<{ code?: unknown }>(request);
  const result = await claimPlayerCode(caller, typeof body?.code === "string" ? body.code.slice(0, 200) : "");
  await settle(started);
  if (!result.ok) return privateJson({ error: result.error }, result.status);
  await audit({
    action: "PLAYER_CODE_CLAIMED",
    actor_role: "user",
    entity_type: "player",
    entity_id: result.player.playerId,
    new_value: { user: owner.id, linked: result.linked },
  });
  return privateJson({ player: result.player, linked: result.linked });
}
