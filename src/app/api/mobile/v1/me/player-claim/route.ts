import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ratelimit";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import { getConfig } from "@/lib/mobile/server";
import { hashClaimCode } from "@/lib/pass/claim";

/** Links the signed-in account to a player with the organiser's one-time code. */
export async function POST(request: Request) {
  const config = await getConfig();
  if (!config.flags.player_claim) return NextResponse.json({ error: "Player profiles open after this event." }, { status: 403 });
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const rl = await checkRateLimit({ key: `claim:${owner.id}`, limit: 10, windowSeconds: 3600 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many tries. Wait an hour." }, { status: 429 });
  const body = await readJson<{ code?: string }>(request);
  const hash = hashClaimCode(String(body?.code ?? ""));
  const { data } = await db().from("player_claim_codes").select("id, player_id, expires_at, used_at, revoked_at").eq("code_hash", hash).maybeSingle();
  const code = data as { id: string; player_id: string; expires_at: string; used_at: string | null; revoked_at: string | null } | null;
  if (!code || code.used_at || code.revoked_at || Date.parse(code.expires_at) < Date.now()) {
    return NextResponse.json({ error: "That code is not valid. Ask the tournament desk for a new one." }, { status: 400 });
  }
  const { data: used } = await db()
    .from("player_claim_codes")
    .update({ used_at: new Date().toISOString(), used_by: owner.id })
    .eq("id", code.id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  if (!used) return NextResponse.json({ error: "That code has just been used." }, { status: 409 });
  await db().from("player_claims").upsert({ user_id: owner.id, player_id: code.player_id }, { onConflict: "user_id,player_id", ignoreDuplicates: true });
  await audit({ action: "PLAYER_CLAIMED", actor_role: "user", entity_type: "player", entity_id: code.player_id, new_value: { user: owner.id } });
  return privateJson({ playerId: code.player_id });
}
