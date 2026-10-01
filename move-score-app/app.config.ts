import type { ExpoConfig, ConfigContext } from "expo/config";

/**
 * Move Score app configuration. Environment comes from EAS build profiles
 * (eas.json): APP_ENV selects the API and the bundle id suffix, so a staging
 * build can sit next to the store app on the same phone.
 */
const APP_ENV = (process.env.APP_ENV ?? "development") as "development" | "staging" | "production";
const BUNDLE = process.env.MS_BUNDLE_ID ?? "org.mbeg.movescore";
const suffix = APP_ENV === "production" ? "" : `.${APP_ENV === "staging" ? "staging" : "dev"}`;
const API = {
  development: process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3000",
  staging: process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://staging.tour.mbeg.org",
  production: process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://mb-tournament.vercel.app",
}[APP_ENV];
const WEB_HOST = new URL(API).host;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: APP_ENV === "production" ? "Move Score" : `Move Score ${APP_ENV === "staging" ? "Staging" : "Dev"}`,
  slug: "move-score",
  scheme: "movescore",
  version: "1.0.0",
  orientation: "default",
  icon: "./assets/brand/icon.png",
  userInterfaceStyle: "automatic",
  backgroundColor: "#00000b",
  runtimeVersion: { policy: "appVersion" },
  updates: process.env.EAS_PROJECT_ID ? { url: `https://u.expo.dev/${process.env.EAS_PROJECT_ID}` } : undefined,
  ios: {
    bundleIdentifier: `${BUNDLE}${suffix}`,
    supportsTablet: true,
    usesAppleSignIn: true,
    associatedDomains: [`applinks:${WEB_HOST}`],
    infoPlist: {
      NSCameraUsageDescription: "Move Score uses the camera to scan the venue code that stamps your event pass.",
      NSSupportsLiveActivities: true,
      NSSupportsLiveActivitiesFrequentUpdates: true,
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: `${BUNDLE}${suffix}`,
    adaptiveIcon: { foregroundImage: "./assets/brand/adaptive-icon.png", backgroundColor: "#01041A" },
    permissions: ["android.permission.CAMERA", "android.permission.VIBRATE", "android.permission.POST_NOTIFICATIONS"],
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? undefined,
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: WEB_HOST, pathPrefix: "/v/" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: { bundler: "metro", output: "single", favicon: "./assets/brand/icon.png" },
  plugins: [
    "expo-router",
    ["expo-splash-screen", { image: "./assets/brand/splash.png", imageWidth: 220, resizeMode: "contain", backgroundColor: "#00000b" }],
    "expo-font",
    "expo-sqlite",
    "expo-secure-store",
    "expo-localization",
    "expo-web-browser",
    "expo-apple-authentication",
    ["expo-camera", { cameraPermission: "Move Score uses the camera to scan the venue code that stamps your event pass.", recordAudioAndroid: false }],
    ["expo-notifications", { icon: "./assets/brand/notification-icon.png", color: "#FCFC00" }],
    ["@react-native-google-signin/google-signin", { iosUrlScheme: process.env.GOOGLE_IOS_URL_SCHEME ?? "com.googleusercontent.apps.placeholder" }],
    ["react-native-share", { ios: ["instagram-stories", "instagram", "whatsapp"], android: ["com.instagram.android", "com.whatsapp"] }],
    [
      "expo-widgets",
      {
        // The lock-screen score is registered at runtime (src/live/MatchScoreActivity.tsx).
        widgets: [],
        enablePushNotifications: true,
      },
    ],
    ["expo-build-properties", { ios: { deploymentTarget: "16.4" }, android: { minSdkVersion: 26 } }],
    ...(process.env.SENTRY_ORG ? [["@sentry/react-native/expo", { organization: process.env.SENTRY_ORG, project: "move-score" }] as [string, object]] : []),
  ],
  experiments: { typedRoutes: true },
  extra: {
    appEnv: APP_ENV,
    apiBaseUrl: API,
    sentryDsn: process.env.SENTRY_DSN ?? null,
    googleWebClientId: process.env.GOOGLE_WEB_CLIENT_ID ?? null,
    googleIosClientId: process.env.GOOGLE_IOS_CLIENT_ID ?? null,
    metaAppId: process.env.META_APP_ID ?? null,
    eas: process.env.EAS_PROJECT_ID ? { projectId: process.env.EAS_PROJECT_ID } : undefined,
  },
});
