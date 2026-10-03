import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ratelimit";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { PLAYER_PHOTO } from "@/lib/mobile/contract";
import { checkPhoto, loadMyPlayer, setMyPhoto } from "@/lib/players/claims";

/**
 * POST { image: base64 } → { player }. The app resizes to about 512 px JPEG
 * first (expo-image-manipulator); the server accepts JPEG, PNG or WebP up to
 * 1.5 MB and 2048 px a side, checked by the bytes themselves, and stores it in
 * the media bucket with its own key. Twenty uploads an hour per account.
 */
export async function POST(request: Request) {
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > Math.ceil((PLAYER_PHOTO.maxBytes * 4) / 3) + 1024) return privateJson({ error: "That photo is too large. Pick a smaller one." }, 413);
  const rl = await checkRateLimit({ key: `pphoto:${owner.id}`, limit: 20, windowSeconds: 3600 });
  if (!rl.allowed) return privateJson({ error: "Too many photo changes. Try again later." }, 429);
  let body: { image?: unknown } | null = null;
  try {
    body = (await request.json()) as { image?: unknown };
  } catch {
    body = null;
  }
  const photo = checkPhoto(body?.image);
  if (!photo.ok) return privateJson({ error: photo.error }, 400);
  const url = await setMyPhoto(owner.id, photo);
  if (!url) return privateJson({ error: "Enter your player code first." }, 404);
  await audit({ action: "PLAYER_PHOTO_UPDATED", actor_role: "user", entity_type: "user", entity_id: owner.id, new_value: { bytes: photo.bytes.length, type: photo.type } });
  return privateJson({ player: await loadMyPlayer(owner.id) });
}
