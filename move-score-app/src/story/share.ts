/**
 * Handing a finished image to the phone: the system share sheet (Instagram
 * Stories, WhatsApp, Messages, Save Image all live there), or straight to
 * Instagram Stories when the Meta app id is set. On the web: the browser's
 * share sheet with the file, else a download.
 */
import { Platform } from "react-native";
import * as Sharing from "expo-sharing";
import { config } from "../config";

export type ShareResult = "shared" | "closed" | "failed";

async function shareOnWeb(uri: string, name: string): Promise<ShareResult> {
  const blob = await (await fetch(uri)).blob();
  const file = new File([blob], name, { type: blob.type || "image/jpeg" });
  const nav = globalThis.navigator as Navigator | undefined;
  if (nav?.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: "Move Score" });
      return "shared";
    } catch {
      return "closed";
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return "shared";
}

/** The system share sheet with the image. */
export async function shareImage(uri: string, mimeType: "image/jpeg" | "image/png" = "image/jpeg"): Promise<ShareResult> {
  try {
    if (Platform.OS === "web") return await shareOnWeb(uri, mimeType === "image/png" ? "move-score.png" : "move-score-story.jpg");
    await Sharing.shareAsync(uri, { mimeType, UTI: mimeType === "image/png" ? "public.png" : "public.jpeg", dialogTitle: "Share your story" });
    return "shared";
  } catch {
    return "closed";
  }
}

/** Straight into an Instagram story when the app can (native, Meta app id set, flag on). */
export function canShareToStories(flagOn: boolean): boolean {
  return Platform.OS !== "web" && Boolean(config.metaAppId) && flagOn;
}

export async function shareToStories(uri: string): Promise<ShareResult> {
  try {
    const mod = await import("react-native-share");
    await mod.default.shareSingle({ social: mod.Social.InstagramStories, appId: config.metaAppId!, backgroundImage: uri, backgroundBottomColor: "#000000", backgroundTopColor: "#0a1438" });
    return "shared";
  } catch {
    return "closed";
  }
}
