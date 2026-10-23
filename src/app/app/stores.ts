/**
 * Where the Move Score app is downloaded from, for the /app page and its stable
 * redirects (/app/ios, /app/android). The Android APK itself is ANDROID_APK
 * (src/app/movescore/android/apk.ts), bumped on every new build.
 */
import { ANDROID_APK } from "../movescore/android/apk";

export const APP_STORE_ID = "6818620996";
export const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;
/**
 * Until the App Store approves the app, iPhones get it through Apple TestFlight's public link
 * (external group "MB", owner's decision 23 Oct 2026). Once the App Store page is live the
 * page and /app/ios switch to the App Store by themselves; IOS_TESTFLIGHT_URL overrides the link.
 */
export const TESTFLIGHT_URL = process.env.IOS_TESTFLIGHT_URL || "https://testflight.apple.com/join/UaV8WF3z";
export { ANDROID_APK };

/**
 * Whether the app can be downloaded from the App Store yet, from Apple's public
 * lookup (cached 10 minutes). Until the first approval the store page is a 404, so
 * the page shows "coming soon" instead of a dead link and switches by itself once
 * Apple publishes the app. Any failure reads as "not yet".
 */
export async function appStoreLive(): Promise<boolean> {
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${APP_STORE_ID}`, {
      next: { revalidate: 600 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { resultCount?: number };
    return (json.resultCount ?? 0) > 0;
  } catch {
    return false;
  }
}

export type Platform = "ios" | "android" | "other";

/** The visitor's phone, from the user agent, so their store is shown first. */
export function platformOf(userAgent: string | null): Platform {
  const ua = userAgent ?? "";
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua))) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}
