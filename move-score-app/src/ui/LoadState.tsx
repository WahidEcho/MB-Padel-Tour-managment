/**
 * What a page shows while the data it needs is not on the phone: loading, no
 * signal, a server error, or gone. Only for a page with nothing saved to show;
 * a page with saved data keeps showing it under the offline banner (ui/Offline.tsx).
 *
 *   if (!b.data) return <Screen><BackHeader label="Back" /><LoadState queries={[b]} what="this tournament" notFound={<Empty … />} /></Screen>;
 *
 * With no signal it says so in the middle of the page with a Try again button,
 * and reloads by itself once the phone is back online (React Query resumes the
 * paused reads; a read that failed is asked again every few seconds meanwhile).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, View, useWindowDimensions } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import type { FetchStatus } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { isOffline } from "../api/queries";
import { checkNetwork, useOnline } from "../api/network";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display } from "./Text";
import { Button, Empty } from "./Bits";

/** The part of a React Query result this reads. */
export interface LoadQuery {
  data: unknown;
  error: unknown;
  isError: boolean;
  fetchStatus: FetchStatus;
  isEnabled?: boolean;
  refetch: () => Promise<unknown>;
}

export type LoadKind = "loading" | "offline" | "error" | "notFound";

export const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;

/** Why the page has nothing to show yet, judged from the reads it is missing. */
export function loadKind(queries: LoadQuery[], online: boolean): LoadKind {
  const missing = queries.filter((q) => q.data === undefined);
  if (missing.some((q) => q.isError && isNotFound(q.error))) return "notFound";
  // Paused: React Query holds a read while the phone has no connection.
  if (missing.some((q) => q.fetchStatus === "paused" || (q.isError && isOffline(q.error))) || (!online && missing.length > 0)) return "offline";
  if (missing.some((q) => q.isError)) return "error";
  return "loading";
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A failed read is asked again this often while the offline state is up (the network said online, the server did not answer). */
const AUTO_RETRY_MS = 10_000;
/** The loading state offers Try again after this long. */
const SLOW_MS = 12_000;

function NoSignalIcon({ color }: { color: string }) {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 3l18 18" />
      <Path d="M8.6 16.4a4.8 4.8 0 0 1 6.2-.5" />
      <Path d="M5.2 12.9a9.6 9.6 0 0 1 4.3-2.4" />
      <Path d="M14.6 10.6a9.6 9.6 0 0 1 4.2 2.3" />
      <Path d="M1.8 9.2a14.4 14.4 0 0 1 3.9-2.6" />
      <Path d="M10.4 5.1A14.4 14.4 0 0 1 22.2 9.2" />
      <Circle cx={12} cy={19.6} r={0.9} fill={color} stroke="none" />
    </Svg>
  );
}

function ErrorIcon({ color }: { color: string }) {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round">
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 7.5v5.5" />
      <Circle cx={12} cy={16.4} r={0.9} fill={color} stroke="none" />
    </Svg>
  );
}

export interface LoadStateProps {
  /** The reads this page needs; the state is judged from the ones with no data yet. */
  queries?: LoadQuery[];
  /** Set the state yourself instead (a one-off call, not a query). */
  kind?: LoadKind;
  /** Named in the messages: "Move Score couldn't load this tournament". */
  what?: string;
  /** Shown for a 404 (the page's own "not available" message). */
  notFound?: ReactNode;
  /** Runs on Try again (and on reconnecting) besides refetching the queries. */
  onRetry?: () => unknown;
  /** Replaces the server error's message. */
  errorNote?: string;
  /** Sits inside a card or a list instead of filling the page. */
  compact?: boolean;
}

/**
 * Loading → spinner; no signal → "You're offline" with Try again; server error →
 * "Something went wrong" with Try again; 404 → the page's not-found message.
 */
export function LoadState({ queries = [], kind: forced, what = "this page", notFound, onRetry, errorNote, compact = false }: LoadStateProps) {
  const { t } = useTheme();
  const { height } = useWindowDimensions();
  const online = useOnline();
  const kind = forced ?? loadKind(queries, online);
  const [busy, setBusy] = useState(false);
  const [stillOffline, setStillOffline] = useState(false);
  const [slow, setSlow] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The latest values for timers and listeners, without restarting them on every render.
  const latest = useRef({ queries, onRetry });
  latest.current = { queries, onRetry };

  /** Asks again: the reads still missing (or failed) and the page's own retry. */
  const askAgain = useCallback(async (all: boolean) => {
    const { queries: qs, onRetry: extra } = latest.current;
    const due = qs.filter((q) => q.isEnabled !== false && (q.data === undefined || q.isError) && (all || q.fetchStatus !== "fetching"));
    await Promise.all([...due.map((q) => q.refetch()), Promise.resolve(extra?.())]);
  }, []);

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    setStillOffline(false);
    try {
      const up = await checkNetwork();
      if (!up) {
        // Nothing to try without a connection: a beat of "Trying…", then say so.
        await wait(700);
        if (alive.current) setStillOffline(true);
        return;
      }
      // A paused or slow read can take a while; the button comes back after 15 s whatever happens.
      await Promise.race([askAgain(true).catch(() => {}), wait(15_000)]);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // Back online after a page set its own state: run its retry (queries resume by themselves).
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current && forced === "offline") void Promise.resolve(latest.current.onRetry?.()).catch(() => {});
    if (online) setStillOffline(false);
    wasOnline.current = online;
  }, [online, forced]);

  // Offline with nothing to show: look at the connection now and then, and ask again once it is up.
  useEffect(() => {
    if (kind !== "offline" || !latest.current.queries.length) return;
    const id = setInterval(() => {
      void checkNetwork().then((up) => (up ? askAgain(false) : undefined)).catch(() => {});
    }, AUTO_RETRY_MS);
    return () => clearInterval(id);
  }, [kind, askAgain]);

  useEffect(() => {
    if (kind !== "loading") return setSlow(false);
    const id = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(id);
  }, [kind]);

  if (kind === "notFound") return <>{notFound ?? <Empty title="Not found" body="It may have been moved or removed." />}</>;

  const frame = { alignItems: "center" as const, justifyContent: "center" as const, gap: 8, paddingHorizontal: 12, ...(compact ? { paddingVertical: 20 } : { minHeight: Math.max(320, height * 0.55), paddingVertical: 24 }) };

  if (kind === "loading") {
    return (
      <View style={frame} accessibilityLabel={`Loading ${what}`} accessibilityLiveRegion="polite">
        <ActivityIndicator color={t.ink3} size={compact ? "small" : "large"} />
        <Body tone="ink3" size={13}>{slow ? "This is taking longer than usual…" : "Loading…"}</Body>
        {slow ? <Button kind="ghost" label={busy ? "Trying…" : "Try again"} disabled={busy} onPress={() => void retry()} style={{ marginTop: 6, minWidth: 160 }} /> : null}
      </View>
    );
  }

  const offline = kind === "offline";
  const firstError = queries.find((q) => q.data === undefined && q.isError)?.error;
  // A refusal the person can act on (a lapsed referee code, say) is worth naming; a 500 is not.
  const serverSays = firstError instanceof ApiError && firstError.status >= 400 && firstError.status < 500 ? firstError.message : null;
  const title = offline ? "You're offline" : "Something went wrong";
  const body = offline ? "Connect to the internet and try again." : (errorNote ?? serverSays ?? `Move Score couldn't load ${what}. Try again in a moment.`);
  const note = offline ? (stillOffline ? "Still no connection. Check Wi-Fi or mobile data." : "This page loads by itself once you're back online.") : null;
  return (
    <View style={frame} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <View style={{ width: compact ? 56 : 68, height: compact ? 56 : 68, borderRadius: 34, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, alignItems: "center", justifyContent: "center", marginBottom: 6 }}>
        {offline ? <NoSignalIcon color={t.ink2} /> : <ErrorIcon color={t.ink2} />}
      </View>
      <Display size={compact ? 17 : 20} style={{ textAlign: "center" }}>{title}</Display>
      <Body tone="ink2" size={14} style={{ textAlign: "center", maxWidth: 300 }}>{body}</Body>
      <Button
        label={busy ? "Trying…" : "Try again"}
        disabled={busy}
        icon={busy ? <ActivityIndicator size="small" color={t.btnInk} /> : undefined}
        onPress={() => void retry()}
        style={{ marginTop: 10, minWidth: 200, alignSelf: compact ? "stretch" : "center" }}
      />
      {note ? (
        <Body tone="ink3" size={12} style={{ textAlign: "center", marginTop: 4 }} accessibilityLiveRegion="polite">
          {note}
        </Body>
      ) : null}
    </View>
  );
}
