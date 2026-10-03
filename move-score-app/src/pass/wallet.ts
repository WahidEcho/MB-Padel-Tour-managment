/**
 * Which wallet button the pass shows, and what tapping it does.
 *
 * Showing: the server's `apple_wallet` flag (platform_settings → flags; on by
 * default) puts the "Add to Apple Wallet" badge on Apple devices. Google Wallet is
 * hidden for now: its route and the old `wallet` flag stay, GOOGLE_WALLET_BUTTON
 * switches the button back on.
 *
 * Tapping: the server signs the .pkpass only when its certificates are set
 * (config.walletReady.apple, and the route answers 503 otherwise). The app asks
 * the route first (HEAD) and then hands the link to Safari, which shows the system
 * Add Pass sheet; a pass the server can't make yet gets a calm note instead.
 */
import { Linking, Platform } from "react-native";
import { apiUrl } from "../api/client";

export const GOOGLE_WALLET_BUTTON = false;

export const WALLET_NOT_READY = "Apple Wallet is coming soon. Your pass works right here in the app until then.";

/** iPhone, iPad, or Safari on an Apple device (the web build). */
function appleDevice(): boolean {
  if (Platform.OS === "ios") return true;
  if (Platform.OS !== "web") return false;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /iPhone|iPad|iPod|Macintosh/.test(ua);
}

export function walletButton(flags: Record<string, boolean> | undefined): "apple" | "google" | null {
  if (!flags) return null;
  if (appleDevice()) return flags.apple_wallet === true ? "apple" : null;
  if (Platform.OS === "android" && GOOGLE_WALLET_BUTTON && flags.wallet === true) return "google";
  return null;
}

/** Null when the Add Pass sheet was handed to the system; otherwise the note to show. */
export async function addToAppleWallet(passId: string, ready: boolean | undefined): Promise<string | null> {
  if (ready === false) return WALLET_NOT_READY;
  const url = apiUrl(`/api/mobile/v1/passes/${passId}/apple`);
  let status = 0;
  try {
    status = (await fetch(url, { method: "HEAD" })).status;
  } catch {
    return "Can't reach Move Score right now. Check your connection and try again.";
  }
  if (status === 503) return WALLET_NOT_READY;
  if (status === 404) return "Your pass isn't on the server yet. Pull down to refresh, then try again.";
  if (status < 200 || status >= 300) return "Apple Wallet didn't answer. Try again in a moment.";
  // Safari downloads the signed pass and presents the system "Add to Apple Wallet" sheet.
  await Linking.openURL(url);
  return null;
}

export async function addToGoogleWallet(passId: string): Promise<void> {
  await Linking.openURL(apiUrl(`/api/mobile/v1/passes/${passId}/google`));
}
