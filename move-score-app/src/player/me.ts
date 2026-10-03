/**
 * The player this account is linked to with a player code: who they are, their
 * matches, their phone and photo. Signed-in only; the server is the source of
 * truth and the last answer is kept on the phone for offline viewing.
 */
import { Platform } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { PLAYER_PHOTO, type MMyPlayer } from "@core";
import { api } from "../api/client";
import { queryClient } from "../api/queries";
import { session } from "../state/session";
import { getJson, setJson, removeKey } from "../state/kv";

const KEY = "ms.myPlayer";
const qk = (userId: string | undefined) => ["me-player", userId ?? "guest"] as const;

function remember(userId: string, player: MMyPlayer | null) {
  queryClient.setQueryData(qk(userId), player);
  if (player) setJson(KEY, { userId, player });
  else removeKey(KEY);
}

/** The linked player, or null. Undefined while the first answer is on its way. */
export function useMyPlayer() {
  const userId = session.use((s) => s.user?.id);
  const cached = getJson<{ userId: string; player: MMyPlayer } | null>(KEY, null);
  return useQuery({
    queryKey: qk(userId),
    enabled: Boolean(userId),
    queryFn: async () => {
      const r = await api<{ player: MMyPlayer | null }>("/api/mobile/v1/me/player", { who: "me" });
      if (userId) remember(userId, r.player);
      return r.player;
    },
    initialData: cached && cached.userId === userId ? cached.player : undefined,
    staleTime: 30_000,
  });
}

/** Fresh from the server: used right after signing in to decide whether to ask for a code. */
export async function fetchMyPlayer(): Promise<MMyPlayer | null> {
  const r = await api<{ player: MMyPlayer | null }>("/api/mobile/v1/me/player", { who: "me" });
  const uid = session.get().user?.id;
  if (uid) remember(uid, r.player);
  return r.player;
}

export async function claimPlayerCode(code: string): Promise<{ player: MMyPlayer; linked: number }> {
  const r = await api<{ player: MMyPlayer; linked: number }>("/api/mobile/v1/me/player/claim", { who: "me", body: { code } });
  const uid = session.get().user?.id;
  if (uid) remember(uid, r.player);
  return r;
}

export async function savePlayerPhone(phone: string): Promise<MMyPlayer> {
  const r = await api<{ player: MMyPlayer }>("/api/mobile/v1/me/player", { method: "PATCH", who: "me", body: { phone } });
  const uid = session.get().user?.id;
  if (uid) remember(uid, r.player);
  return r.player;
}

export async function unlinkPlayer(): Promise<void> {
  await api("/api/mobile/v1/me/player", { method: "DELETE", who: "me" });
  const uid = session.get().user?.id;
  if (uid) remember(uid, null);
}

/**
 * Takes or picks a photo, squares it in the system cropper, resizes it to about
 * 512 px JPEG on the phone and uploads it. Null when the person cancelled.
 */
export async function changePlayerPhoto(source: "camera" | "library"): Promise<MMyPlayer | null> {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1, exif: false };
  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error("Move Score needs the camera to take your photo. Allow it in Settings, or choose a photo instead.");
  }
  const res = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (res.canceled || !res.assets?.[0]) return null;
  const asset = res.assets[0];
  const ctx = ImageManipulator.manipulate(asset.uri);
  const side = PLAYER_PHOTO.targetSide;
  if ((asset.width ?? 0) >= (asset.height ?? 0)) {
    if ((asset.width ?? side + 1) > side) ctx.resize({ width: side });
  } else if ((asset.height ?? 0) > side) ctx.resize({ height: side });
  const rendered = await ctx.renderAsync();
  const out = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.82, base64: true });
  if (!out.base64) throw new Error("Could not read that photo. Try another one.");
  const r = await api<{ player: MMyPlayer }>("/api/mobile/v1/me/player/photo", { who: "me", body: { image: out.base64 }, timeoutMs: 30_000 });
  const uid = session.get().user?.id;
  if (uid) remember(uid, r.player);
  return r.player;
}

/** Whether the camera is worth offering (no camera in the web build). */
export const canUseCamera = Platform.OS !== "web";

/* ---------- the one-time "Are you playing?" prompt after signing in ---------- */

const ASKED = "ms.playerPrompt.asked";

/** True once per account: the prompt was shown or skipped and is not shown again. */
export function playerPromptAsked(userId: string): boolean {
  return getJson<string[]>(ASKED, []).includes(userId);
}

export function markPlayerPromptAsked(userId: string) {
  const list = getJson<string[]>(ASKED, []);
  if (!list.includes(userId)) setJson(ASKED, [...list, userId].slice(-10));
}
