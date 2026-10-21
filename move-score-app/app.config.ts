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
  production: process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://tour.mbeg.org",
}[APP_ENV];
const WEB_HOST = new URL(API).host;
// The site's former address (same deployment). Production builds still claim its
// /v/ and /m/ links so venue and match codes printed or shared before the move to
// tour.mbeg.org keep opening the app. Both hosts serve the same AASA and assetlinks.
const LEGACY_WEB_HOST = "mb-tournament.vercel.app";
const LINK_HOSTS = APP_ENV === "production" && WEB_HOST !== LEGACY_WEB_HOST ? [WEB_HOST, LEGACY_WEB_HOST] : [WEB_HOST];

// OWNER TO FILL: the EAS project id from `eas init` (expo.dev → project → ID).
// The EAS_PROJECT_ID environment variable wins when set; until either exists,
// OTA updates and the EAS project link stay off.
const EAS_PROJECT_ID_DEFAULT = "81d21117-5604-4f55-9cbf-484613f1df71";
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID || EAS_PROJECT_ID_DEFAULT || undefined;
// The Expo account that owns the project (EXPO_OWNER), when building under an organisation.
const OWNER = process.env.EXPO_OWNER || "move-beyond";

// Required-reason APIs used by the app and its React Native / Expo modules
// (Apple privacy manifest). Move Score does no tracking.
const PRIVACY_MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyAccessedAPITypes: [
    { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults", NSPrivacyAccessedAPITypeReasons: ["CA92.1"] },
    { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp", NSPrivacyAccessedAPITypeReasons: ["C617.1"] },
    { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime", NSPrivacyAccessedAPITypeReasons: ["35F9.1"] },
    { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace", NSPrivacyAccessedAPITypeReasons: ["E174.1"] },
  ],
};

// iPhone lock screen and home screen (expo-widgets). The widget extension shares
// data with the app through an App Group, which must be in both provisioning
// profiles (app and ExpoWidgetsTarget) — see docs/device-install.md. The store
// bundle's group is group.org.mbeg.movescore (already in the App Store and ad-hoc
// profiles); dev and staging bundles keep expo-widgets' own default, group.<bundle id>.
//   MS_LIVE_ACTIVITIES=0  no widget extension at all (no App Group needed): builds
//                         with profiles that lack the group; no lock-screen cards.
//   MS_WIDGETS=0          the extension carries only the Live Activity, no My matches widget.
//   MS_APP_GROUP=…        another App Group id (must match both profiles).
const flag = (v: string | undefined, fallback: boolean) => (v === undefined || v === "" ? fallback : !/^(0|false|off|no)$/i.test(v));
const IOS_BUNDLE = `${BUNDLE}${suffix}`;
const LIVE_ACTIVITIES = flag(process.env.MS_LIVE_ACTIVITIES, true);
const WIDGETS = LIVE_ACTIVITIES && flag(process.env.MS_WIDGETS, true);
const APP_GROUP = process.env.MS_APP_GROUP || (IOS_BUNDLE === "org.mbeg.movescore" ? "group.org.mbeg.movescore" : `group.${IOS_BUNDLE}`);
const WIDGET_TARGET_BUNDLE = `${IOS_BUNDLE}.ExpoWidgetsTarget`;

// The venue map: the blue dot and walking directions, only while the map is open.
const LOCATION_USAGE = "Move Score shows where you are on the venue map and gives walking directions to courts and facilities. Your location stays on your phone.";
// One camera string for every use (story photo, player photo, venue code), set the same way by every plugin.
const CAMERA_USAGE = "Take a photo for your Move Score story or your player photo. The camera also scans the venue code that stamps your event pass.";
const PHOTOS_USAGE = "Choose a photo for your Move Score story or your player photo.";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  ...(OWNER ? { owner: OWNER } : {}),
  name: APP_ENV === "production" ? "Move Score" : `Move Score ${APP_ENV === "staging" ? "Staging" : "Dev"}`,
  slug: "move-score",
  scheme: "movescore",
  version: "1.0.1",
  orientation: "default",
  icon: "./assets/brand/icon.png",
  userInterfaceStyle: "automatic",
  backgroundColor: "#00000b",
  runtimeVersion: { policy: "appVersion" },
  updates: EAS_PROJECT_ID ? { url: `https://u.expo.dev/${EAS_PROJECT_ID}` } : undefined,
  ios: {
    bundleIdentifier: IOS_BUNDLE,
    supportsTablet: true,
    usesAppleSignIn: true,
    associatedDomains: LINK_HOSTS.map((h) => `applinks:${h}`),
    // No NSMotionUsageDescription: the pass tilt (Reanimated useAnimatedSensor) reads
    // CMMotionManager device motion, which needs no permission; nothing uses
    // motion activity or the pedometer.
    infoPlist: {
      NSCameraUsageDescription: CAMERA_USAGE,
      NSPhotoLibraryUsageDescription: PHOTOS_USAGE,
      ...(LIVE_ACTIVITIES ? { NSSupportsLiveActivities: true, NSSupportsLiveActivitiesFrequentUpdates: true } : {}),
      ITSAppUsesNonExemptEncryption: false,
    },
    privacyManifests: PRIVACY_MANIFEST,
    // A master referee's "Call for assistance" alert breaks through Focus and the
    // notification summary (Expo push interruptionLevel "time-sensitive",
    // src/lib/referees/assistance.ts). The App ID needs the Time Sensitive
    // Notifications capability in the Apple developer portal (docs/device-install.md).
    entitlements: { "com.apple.developer.usernotifications.time-sensitive": true },
  },
  android: {
    package: `${BUNDLE}${suffix}`,
    adaptiveIcon: { foregroundImage: "./assets/brand/adaptive-icon.png", backgroundColor: "#01041A" },
    permissions: ["android.permission.CAMERA", "android.permission.VIBRATE", "android.permission.POST_NOTIFICATIONS"],
    blockedPermissions: ["android.permission.RECORD_AUDIO"],
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? undefined,
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        // /v/: the venue code; /m/: a match's check-in code; /r: a court's referee QR
        // (exactly "/r", so /register and the rest stay in the browser); /c: a team
        // coach card's QR (exactly "/c", so /coach stays in the browser).
        data: LINK_HOSTS.flatMap((host) => [
          { scheme: "https", host, pathPrefix: "/v/" },
          { scheme: "https", host, pathPrefix: "/m/" },
          { scheme: "https", host, path: "/r" },
          { scheme: "https", host, path: "/c" },
        ]),
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: { bundler: "metro", output: "single", favicon: "./assets/brand/icon.png" },
  // The system's permission prompts in Spanish and French (the app's own words: src/i18n).
  locales: { es: "./locales/es.json", fr: "./locales/fr.json" },
  plugins: [
    "expo-router",
    ["expo-splash-screen", { image: "./assets/brand/splash.png", imageWidth: 220, resizeMode: "contain", backgroundColor: "#00000b" }],
    "expo-font",
    "expo-sqlite",
    // Keychain storage without biometrics (no requireAuthentication), so no Face ID string.
    ["expo-secure-store", { faceIDPermission: false }],
    // English, Spanish and French: the iPhone's per-app Language setting and Android 13's
    // app languages list them, and "Automatic" (Account → Language) follows that choice.
    ["expo-localization", { supportedLocales: { ios: ["en", "es", "fr"], android: ["en", "es", "fr"] } }],
    // Google sign-in runs in the in-app browser sheet (ASWebAuthenticationSession /
    // Custom Tabs) and comes back on the movescore:// scheme: no Google SDK or URL scheme.
    "expo-web-browser",
    "expo-apple-authentication",
    // The camera takes story photos and reads the venue QR code; it never records
    // video, so there is no microphone permission on either platform.
    [
      "expo-camera",
      {
        cameraPermission: CAMERA_USAGE,
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    // Story photos from the library. The system picker needs no library permission on
    // iOS 14+ / Android 13+; the string covers older systems. No microphone (no video).
    [
      "expo-image-picker",
      {
        photosPermission: PHOTOS_USAGE,
        cameraPermission: CAMERA_USAGE,
        microphonePermission: false,
      },
    ],
    // remote-notification background mode: iOS may wake the app for a push (and for a
    // card started by push) so it can register the card's update token and refresh the widget.
    ["expo-notifications", { icon: "./assets/brand/notification-icon.png", color: "#FCFC00", enableBackgroundRemoteNotifications: true }],
    // The venue map's blue dot and directions: while the map is open only (no background location).
    [
      "expo-location",
      {
        locationWhenInUsePermission: LOCATION_USAGE,
        // The plugin writes the "Always" strings too; the app never asks for them, so they say the same.
        locationAlwaysAndWhenInUsePermission: LOCATION_USAGE,
        locationAlwaysPermission: LOCATION_USAGE,
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: false,
      },
    ],
    ["react-native-share", { ios: ["instagram-stories", "instagram", "whatsapp"], android: ["com.instagram.android", "com.whatsapp"] }],
    ...(LIVE_ACTIVITIES
      ? [
          [
            "expo-widgets",
            {
              bundleIdentifier: WIDGET_TARGET_BUNDLE,
              groupIdentifier: APP_GROUP,
              // The lock-screen card is registered at runtime (src/live/MatchScoreActivity.tsx);
              // the My matches widget's layout is src/live/MyMatchesWidget.tsx.
              widgets: WIDGETS
                ? [
                    {
                      name: "MyMatches",
                      displayName: "My matches",
                      description: "Your next match, its court and time, and the live score.",
                      supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular", "accessoryInline", "accessoryCircular"],
                    },
                  ]
                : [],
              enablePushNotifications: true,
              // The plugin writes NSSupportsLiveActivitiesFrequentUpdates from this
              // option (false when missing), overriding infoPlist above.
              frequentUpdates: true,
            },
          ] as [string, object],
        ]
      : []),
    ["expo-build-properties", { ios: { deploymentTarget: "16.4" }, android: { minSdkVersion: 26 } }],
    ...(process.env.SENTRY_ORG ? [["@sentry/react-native/expo", { organization: process.env.SENTRY_ORG, project: "move-score" }] as [string, object]] : []),
  ],
  experiments: { typedRoutes: true },
  extra: {
    appEnv: APP_ENV,
    apiBaseUrl: API,
    sentryDsn: process.env.SENTRY_DSN || undefined,
    metaAppId: process.env.META_APP_ID || undefined,
    liveActivities: LIVE_ACTIVITIES,
    widgets: WIDGETS,
    eas: EAS_PROJECT_ID ? { projectId: EAS_PROJECT_ID } : undefined,
  },
});
