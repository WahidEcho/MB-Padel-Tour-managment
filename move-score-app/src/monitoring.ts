/**
 * Crash and error reporting (Sentry), on only when a DSN is configured. Never
 * sends codes, tokens or names: only app version, platform and screen.
 */
import * as Sentry from "@sentry/react-native";
import { config, appVersion } from "./config";

let started = false;
export function startMonitoring() {
  if (started || !config.sentryDsn) return;
  started = true;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.appEnv,
    release: `move-score@${appVersion}`,
    sendDefaultPii: false,
    tracesSampleRate: 0.05,
    beforeBreadcrumb: (b) => (b.category === "fetch" || b.category === "xhr" ? { ...b, data: { url: String(b.data?.url ?? "").split("?")[0], status_code: b.data?.status_code } } : b),
  });
}

export function report(err: unknown, context: Record<string, string | number | boolean | null> = {}) {
  if (!started) return;
  Sentry.captureException(err, { extra: context });
}
