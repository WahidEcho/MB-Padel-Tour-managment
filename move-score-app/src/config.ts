import Constants from "expo-constants";

type Extra = {
  appEnv: "development" | "staging" | "production";
  apiBaseUrl: string;
  sentryDsn: string | null;
  metaAppId: string | null;
  /** This iOS build has the widget extension (Live Activities): app.config.ts MS_LIVE_ACTIVITIES. */
  liveActivities: boolean;
  /** This iOS build has the My matches widget: app.config.ts MS_WIDGETS. */
  widgets: boolean;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

// The iOS build embeds a null `extra` value as `{}`, so only a non-empty string counts.
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const config: Extra = {
  appEnv: (text(extra.appEnv) as Extra["appEnv"] | null) ?? "development",
  apiBaseUrl: (process.env.EXPO_PUBLIC_API_BASE_URL || text(extra.apiBaseUrl) || "http://localhost:3000").replace(/\/$/, ""),
  sentryDsn: text(extra.sentryDsn),
  metaAppId: text(extra.metaAppId),
  // Builds from before these flags had the extension: absent reads as on.
  liveActivities: extra.liveActivities !== false,
  widgets: extra.widgets === true,
};

export const appVersion = Constants.expoConfig?.version ?? "1.0.0";
