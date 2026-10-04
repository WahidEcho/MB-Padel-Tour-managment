import Constants from "expo-constants";

type Extra = {
  appEnv: "development" | "staging" | "production";
  apiBaseUrl: string;
  sentryDsn: string | null;
  metaAppId: string | null;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

// The iOS build embeds a null `extra` value as `{}`, so only a non-empty string counts.
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const config: Extra = {
  appEnv: (text(extra.appEnv) as Extra["appEnv"] | null) ?? "development",
  apiBaseUrl: (process.env.EXPO_PUBLIC_API_BASE_URL || text(extra.apiBaseUrl) || "http://localhost:3000").replace(/\/$/, ""),
  sentryDsn: text(extra.sentryDsn),
  metaAppId: text(extra.metaAppId),
};

export const appVersion = Constants.expoConfig?.version ?? "1.0.0";
