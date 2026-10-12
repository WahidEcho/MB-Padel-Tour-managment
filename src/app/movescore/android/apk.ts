/**
 * The Android app outside Google Play: the latest EAS-built APK. Bump on every new APK build.
 * MOVESCORE_APK_URL overrides the link without a deploy of new code (set it in Vercel and redeploy).
 */
export const ANDROID_APK = {
  url: process.env.MOVESCORE_APK_URL || "https://expo.dev/artifacts/eas/F2gxjCksceyI_BcCoqkdyPsJhJmFTLR3_IjKNuP5QlQ.apk",
  version: "1.0.1",
  build: 7,
  sizeMb: 199,
  builtOn: "13 October 2026",
};
