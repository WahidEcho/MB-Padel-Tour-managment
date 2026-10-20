/**
 * Account → "Edit name and photo": the signed-in person's own name and photo
 * (PATCH /me/account, POST|DELETE /me/account/photo). Apple sends the name only
 * the very first time and never a photo, so this is how an Apple account gets
 * either. Each answer is the account as the server now has it; it is saved on the
 * phone at once so the Account screen changes straight away.
 */
import type { MAccountUser } from "@core";
import { api } from "../api/client";
import { patchUser } from "../state/session";
import { pickSquarePhoto } from "../player/me";

async function keep(user: MAccountUser) {
  await patchUser(user.id, {
    name: user.displayName,
    ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
  });
}

export async function saveAccountName(displayName: string): Promise<void> {
  const r = await api<{ user: MAccountUser }>("/api/mobile/v1/me/account", { method: "PATCH", who: "me", body: { displayName } });
  await keep(r.user);
}

/** Picks, squares, resizes and uploads the account photo. False when the person cancelled. */
export async function changeAccountPhoto(source: "camera" | "library"): Promise<boolean> {
  const image = await pickSquarePhoto(source);
  if (!image) return false;
  const r = await api<{ user: MAccountUser }>("/api/mobile/v1/me/account/photo", { who: "me", body: { image }, timeoutMs: 30_000 });
  await keep(r.user);
  return true;
}

export async function removeAccountPhoto(): Promise<void> {
  const r = await api<{ user: MAccountUser }>("/api/mobile/v1/me/account/photo", { method: "DELETE", who: "me" });
  await keep(r.user);
}
