import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { badRequest, strictBody } from "@/lib/players/http";
import { loadMyPlayer, setMyPhone, unlinkMe } from "@/lib/players/claims";
import { toE164 } from "@/lib/players/phone";
import { syncProfileClaims } from "@/lib/players/link";

async function signedIn(request: Request) {
  const { owner } = await ownerOf(request);
  return owner?.kind === "user" ? owner.id : null;
}

/** GET → { player: MMyPlayer | null }: the player this account is linked to. */
export async function GET(request: Request) {
  const userId = await signedIn(request);
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  // A new entry of the player's profile (a new tournament) joins on its own.
  await syncProfileClaims(userId);
  return privateJson({ player: await loadMyPlayer(userId) });
}

/**
 * PATCH { phone } → { player }. The player's own number for the organisers, in any
 * common way of writing it; stored as E.164 (Egypt by default) in
 * players.self_reported_phone, never in players.phone (the organiser's record that
 * phone codes look entries up by). Empty clears it. Only the `phone` field.
 */
export async function PATCH(request: Request) {
  const userId = await signedIn(request);
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const body = await strictBody(request, ["phone"]);
  if (!body) return badRequest();
  if (typeof body.phone !== "string" || body.phone.length > 40) return privateJson({ error: "Send a phone number." }, 400);
  const raw = body.phone.trim();
  const e164 = raw ? toE164(raw) : null;
  if (raw && !e164) {
    return privateJson({ error: "That doesn't look like a phone number. Include the country code if it isn't Egyptian, e.g. +44 7700 900123." }, 400);
  }
  if (!(await setMyPhone(userId, e164))) return privateJson({ error: "Enter your player code first." }, 404);
  await audit({ action: "PLAYER_PHONE_UPDATED", actor_role: "user", entity_type: "user", entity_id: userId, new_value: { cleared: !e164 } });
  return privateJson({ player: await loadMyPlayer(userId) });
}

/** DELETE → { unlinked }: "this isn't me". The account lets go of its players. */
export async function DELETE(request: Request) {
  const userId = await signedIn(request);
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const unlinked = await unlinkMe(userId);
  await audit({ action: "PLAYER_UNLINKED", actor_role: "user", entity_type: "user", entity_id: userId, new_value: { unlinked } });
  return privateJson({ unlinked });
}
