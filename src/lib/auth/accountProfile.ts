/**
 * Account → "Edit name and photo": the signed-in person's own name and photo.
 *
 * Both are kept in the auth user's user_metadata (see AccountMeta in accounts.ts
 * for the keys and why), written with the person's own access token through
 * Supabase Auth's `PUT /user` (it merges `data` into user_metadata, a null removes
 * a key), so it works with either server key. The name is also written to
 * app_users.display_name, which the rest of the server reads.
 */
import { randomInt } from "crypto";
import { db, mediaPublicUrl } from "@/lib/supabase";
import { ACCOUNT_PHOTO_PREFIX, accountStatus, getAuthUser, isOwnAccountPhoto, updateAuthUser, type AccountMeta } from "./accounts";

/** The user as GET /me returns it, with the avatar (what the app keeps after sign-in). */
export async function accountUser(userId: string, accessToken: string) {
  const s = await accountStatus(userId, accessToken);
  return { id: userId, ...s };
}

type Result = { ok: true } | { ok: false; status: number; error: string };
const AUTH_DOWN: Result = { ok: false, status: 503, error: "Could not save right now. Try again in a moment." };

export async function setAccountName(userId: string, accessToken: string, name: string): Promise<Result> {
  const set = await updateAuthUser(accessToken, { data: { full_name: name, custom_name: name, name_custom: true } });
  if (!set.ok) return set.status === 401 || set.status === 403 ? { ok: false, status: 401, error: "Not signed in" } : AUTH_DOWN;
  const { error } = await db().from("app_users").update({ display_name: name, updated_at: new Date().toISOString() }).eq("auth_user_id", userId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function removeAccountFiles(urls: unknown[]) {
  const paths = [...new Set(urls.filter(isOwnAccountPhoto))].map((u) => u.slice(mediaPublicUrl("").length));
  if (paths.length) await db().storage.from("media").remove(paths);
}

async function currentMeta(accessToken: string): Promise<AccountMeta | null> {
  const me = await getAuthUser(accessToken);
  return me.ok ? ((me.data.user_metadata ?? {}) as AccountMeta) : null;
}

/** Uploads the photo under the account's own key and makes it the account's avatar. */
export async function setAccountPhoto(userId: string, accessToken: string, photo: { bytes: Uint8Array; type: string }): Promise<Result> {
  const before = await currentMeta(accessToken);
  if (!before) return AUTH_DOWN;
  const path = `${ACCOUNT_PHOTO_PREFIX}${userId}/${Date.now()}-${randomInt(1e9).toString(36)}.${EXT[photo.type] ?? "jpg"}`;
  const { error: upErr } = await db().storage.from("media").upload(path, photo.bytes, { contentType: photo.type, upsert: false, cacheControl: "31536000" });
  if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
  const url = mediaPublicUrl(path);
  const set = await updateAuthUser(accessToken, { data: { avatar_url: url, custom_avatar_url: url, avatar_custom: true } });
  if (!set.ok) {
    await removeAccountFiles([url]);
    return AUTH_DOWN;
  }
  await removeAccountFiles([before.custom_avatar_url, before.avatar_url].filter((u) => u !== url));
  return { ok: true };
}

/** "Remove photo": no avatar from now on, even if a provider offers one again. */
export async function removeAccountPhoto(accessToken: string): Promise<Result> {
  const before = await currentMeta(accessToken);
  if (!before) return AUTH_DOWN;
  const set = await updateAuthUser(accessToken, { data: { avatar_url: null, custom_avatar_url: null, avatar_custom: true } });
  if (!set.ok) return AUTH_DOWN;
  await removeAccountFiles([before.custom_avatar_url, before.avatar_url]);
  return { ok: true };
}

/**
 * Account deletion: the photo goes, and the chosen name and photo are cleared from
 * the auth user's metadata (without the secret key the identity itself lingers until
 * staff purge it; signing in again then starts with nothing of the old account's).
 */
export async function forgetAccountProfile(accessToken: string | null) {
  if (!accessToken) return;
  const meta = await currentMeta(accessToken);
  if (!meta) return;
  await removeAccountFiles([meta.custom_avatar_url, meta.avatar_url]);
  if (meta.name_custom !== undefined || meta.avatar_custom !== undefined) {
    const own = isOwnAccountPhoto(meta.avatar_url);
    await updateAuthUser(accessToken, {
      data: {
        name_custom: null,
        custom_name: null,
        avatar_custom: null,
        custom_avatar_url: null,
        ...(own ? { avatar_url: null } : {}),
        ...(meta.name_custom === true && meta.full_name === meta.custom_name ? { full_name: null } : {}),
      },
    });
  }
}
