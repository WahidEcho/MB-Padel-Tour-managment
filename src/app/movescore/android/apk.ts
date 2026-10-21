/**
 * The Android app outside Google Play: the latest APK, published as MoveScore.apk on
 * the GitHub releases of WahidEcho/movescore-android (public, holds only the APK).
 * The link always serves the newest release, so a new build is one new release
 * there; bump the version details below with it. MOVESCORE_APK_URL overrides the
 * link without a code change (set it in Vercel and redeploy).
 */
export const ANDROID_APK = {
  url: process.env.MOVESCORE_APK_URL || "https://github.com/WahidEcho/movescore-android/releases/latest/download/MoveScore.apk",
  version: "1.0.1",
  build: 8,
  sizeMb: 200,
  builtOn: "21 October 2026",
};
