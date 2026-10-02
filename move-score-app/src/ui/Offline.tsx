import { useEffect, useState } from "react";
import { View } from "react-native";
import { isOffline } from "../api/queries";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "./Text";
import { Button, Card } from "./Bits";

/** Data on a live screen counts as old after this long without a fresh answer. */
const OLD_AFTER_MS = 30_000;

/** The part of a React Query result the offline UI reads. */
export interface QueryLike {
  data: unknown;
  error: unknown;
  isError: boolean;
  dataUpdatedAt: number;
}

const clock = (ms: number) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
};

/** No phone signal (or the server is unreachable) and nothing saved to show: say so, offer a retry. */
export function OfflineState({ onRetry, what = "this page" }: { onRetry: () => unknown; what?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Card style={{ alignItems: "center", paddingVertical: 28, gap: 6 }}>
      <Body weight="semi">{"You're offline"}</Body>
      <Body tone="ink2" size={13} style={{ textAlign: "center" }}>
        {`Move Score can't reach the server to load ${what}. Check your connection and try again.`}
      </Body>
      <Button
        label={busy ? "Trying…" : "Retry"}
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void Promise.resolve(onRetry()).finally(() => setBusy(false));
        }}
        style={{ marginTop: 10, alignSelf: "stretch" }}
      />
    </Card>
  );
}

/** Offline when the query failed for want of a network; otherwise a real error (404, 500…). */
export function failedOffline(...qs: QueryLike[]): boolean {
  return qs.some((q) => q.isError && isOffline(q.error));
}

/**
 * "Offline · showing scores from 14:05" while a screen shows saved or old data:
 * a poll failed but the last answer is still on screen, or (on live screens) no
 * fresh answer has arrived for 30 seconds.
 */
export function StaleBanner({ queries, live = false }: { queries: QueryLike[]; live?: boolean }) {
  const { t } = useTheme();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [live]);
  const shown = queries.filter((q) => q.data !== undefined);
  const failed = shown.filter((q) => q.isError);
  const old = live ? shown.filter((q) => q.dataUpdatedAt > 0 && now - q.dataUpdatedAt > OLD_AFTER_MS) : [];
  if (!failed.length && !old.length) return null;
  // The oldest answer on screen is the honest one to name. 0 = saved on the phone before this visit.
  const times = [...failed, ...old].map((q) => q.dataUpdatedAt);
  const since = Math.min(...times);
  const label = `${failed.length ? "Offline" : "Reconnecting"} · ${since > 0 ? `showing scores from ${clock(since)}` : "showing saved scores"}`;
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6, marginBottom: 10 }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.ink3 }} />
      <Body tone="ink2" size={12} weight="semi">{label}</Body>
    </View>
  );
}
