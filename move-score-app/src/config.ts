import Constants from "expo-constants";

type Extra = {
  appEnv: "development" | "staging" | "production";
  apiBaseUrl: string;
  sentryDsn: string | null;
  metaAppId: string | null;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const config: Extra = {
  appEnv: extra.appEnv ?? "development",
  apiBaseUrl: (process.env.EXPO_PUBLIC_API_BASE_URL || extra.apiBaseUrl || "http://localhost:3000").replace(/\/$/, ""),
  sentryDsn: extra.sentryDsn ?? null,
  metaAppId: extra.metaAppId ?? null,
};

export const appVersion = Constants.expoConfig?.version ?? "1.0.0";
