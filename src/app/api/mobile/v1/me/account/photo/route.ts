import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ratelimit";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { PLAYER_PHOTO } from "@/lib/mobile/contract";
import { checkPhoto } from "@/lib/players/claims";
import { bearerOf } from "@/lib/auth/accounts";
import { accountUser, removeAccountPhoto, setAccountPhoto } from "@/lib/auth/accountProfile";

/**
 * The account's own photo (Account → Edit name and photo), apart from a linked
 * player's photo. POST { image: base64 } → { user }: the app resizes to about
 * 512 px JPEG first; the server checks the bytes as for player photos (JPEG, PNG or
 * WebP, 1.5 MB, 2048 px a side) and stores it in the media bucket under
 * accounts/<user id>/. The URL goes into the auth user's metadata, so every later
 * sign-in returns it and a provider's picture never replaces it. DELETE removes it
 * (no photo from then on). Twenty changes an hour per account, shared by both.
 */
async function signedIn(request: Request) {
  const { owner } = await ownerOf(request);
  const token = bearerOf(request);
  if (owner?.kind !== "user" || !token) return null;
  return { userId: owner.id, token };
}

const limited = (userId: string) => checkRateLimit({ key: `acctphoto:${userId}`, limit: 20, windowSeconds: 3600 });

export async function POST(request: Request) {
  const who = await signedIn(request);
  if (!who) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > Math.ceil((PLAYER_PHOTO.maxBytes * 4) / 3) + 1024) return privateJson({ error: "That photo is too large. Pick a smaller one." }, 413);
  const rl = await limited(who.userId);
  if (!rl.allowed) return privateJson({ error: "Too many photo changes. Try again later." }, 429);
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return privateJson({ error: "No photo was sent." }, 400);
  const extra = Object.keys(body).filter((k) => k !== "image");
  if (extra.length) return privateJson({ error: `Unknown field: ${extra[0].slice(0, 40)}` }, 400);
  const photo = checkPhoto((body as { image?: unknown }).image);
  if (!photo.ok) return privateJson({ error: photo.error }, 400);
  const done = await setAccountPhoto(who.userId, who.token, photo);
  if (!done.ok) return privateJson({ error: done.error }, done.status);
  await audit({ action: "APP_ACCOUNT_PHOTO_UPDATED", actor_role: "user", actor_user_id: who.userId, entity_type: "user", entity_id: who.userId, new_value: { bytes: photo.bytes.length, type: photo.type } });
  return privateJson({ user: await accountUser(who.userId, who.token) });
}

export async function DELETE(request: Request) {
  const who = await signedIn(request);
  if (!who) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const rl = await limited(who.userId);
  if (!rl.allowed) return privateJson({ error: "Too many photo changes. Try again later." }, 429);
  const done = await removeAccountPhoto(who.token);
  if (!done.ok) return privateJson({ error: done.error }, done.status);
  await audit({ action: "APP_ACCOUNT_PHOTO_REMOVED", actor_role: "user", actor_user_id: who.userId, entity_type: "user", entity_id: who.userId });
  return privateJson({ user: await accountUser(who.userId, who.token) });
}
