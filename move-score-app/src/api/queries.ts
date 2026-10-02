/**
 * Server state. Every public read is the same URL for every phone, polled only
 * while the screen is on and focused, so the CDN can share one copy between
 * everyone in the venue.
 */
import { QueryClient, focusManager, onlineManager, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { AppState, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MBundle, MConfig, MDiscover, MLive, MMatchDetail, MStandings, MTimeline } from "@core";
import { ApiError, api } from "./client";
import { getJson, setJson } from "../state/kv";

/** A 404 will not fix itself by asking again; network failures and 5xx might. */
function shouldRetry(failures: number, e: unknown): boolean {
  if (e instanceof ApiError && e.status === 404) return false;
  return failures < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: shouldRetry, staleTime: 2_000, gcTime: 30 * 60_000, refetchOnReconnect: true },
  },
});

/** No response at all (offline, server down, timed out): ApiError status 0. */
export const isOffline = (e: unknown) => e instanceof ApiError && e.status === 0;

// Foreground/background drives polling: nothing is fetched while the app is in a pocket.
if (Platform.OS !== "web") {
  AppState.addEventListener("change", (s) => focusManager.setFocused(s === "active"));
}
// No connectivity package is installed, so React Query is told it is always online and
// keeps polling; a failed poll keeps the last answer on screen and the screens show an
// "Offline · showing scores from …" banner from the query's error (ui/Offline.tsx).
onlineManager.setOnline(true);

/** Polls only while this screen is focused. */
export function useScreenFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  return focused;
}

/** Keeps the last good answer on the phone so the app opens instantly, offline included. */
function cached<T>(key: string, fetcher: () => Promise<T>): () => Promise<T> {
  return async () => {
    const v = await fetcher();
    setJson(`q:${key}`, v);
    return v;
  };
}

function initial<T>(key: string): T | undefined {
  return getJson<T | undefined>(`q:${key}`, undefined);
}

/** The saved answer is shown at once but counts as old, so it is fetched again straight away (ids can change). */
const SAVED_IS_OLD = { initialDataUpdatedAt: 0 } as const;

type Opts<T> = Omit<UseQueryOptions<T>, "queryKey" | "queryFn">;

export function useConfig() {
  return useQuery<MConfig>({ queryKey: ["config"], queryFn: cached("config", () => api<MConfig>("/api/mobile/v1/config")), initialData: () => initial<MConfig>("config"), ...SAVED_IS_OLD, staleTime: 60_000 });
}

export function useDiscover() {
  const focused = useScreenFocused();
  return useQuery<MDiscover>({
    queryKey: ["discover"],
    queryFn: cached("discover", () => api<MDiscover>("/api/mobile/v1/discover")),
    initialData: () => initial<MDiscover>("discover"),
    ...SAVED_IS_OLD,
    refetchInterval: focused ? 30_000 : false,
  });
}

export function useBundle(slug: string | undefined, opts: Opts<MBundle> = {}) {
  return useQuery<MBundle>({
    queryKey: ["bundle", slug],
    queryFn: cached(`bundle:${slug}`, () => api<MBundle>(`/api/mobile/v1/t/${slug}/bundle`)),
    initialData: () => (slug ? initial<MBundle>(`bundle:${slug}`) : undefined),
    ...SAVED_IS_OLD,
    enabled: Boolean(slug),
    staleTime: 60_000,
    ...opts,
  });
}

export function useLive(slug: string | undefined, intervalMs = 5_000) {
  const focused = useScreenFocused();
  return useQuery<MLive>({
    queryKey: ["live", slug],
    queryFn: cached(`live:${slug}`, () => api<MLive>(`/api/mobile/v1/t/${slug}/live`)),
    initialData: () => (slug ? initial<MLive>(`live:${slug}`) : undefined),
    ...SAVED_IS_OLD,
    enabled: Boolean(slug),
    refetchInterval: focused ? intervalMs : false,
  });
}

export function useStandings(slug: string | undefined) {
  const focused = useScreenFocused();
  return useQuery<MStandings>({
    queryKey: ["standings", slug],
    queryFn: () => api<MStandings>(`/api/mobile/v1/t/${slug}/standings`),
    enabled: Boolean(slug),
    refetchInterval: focused ? 30_000 : false,
  });
}

export function useMatch(id: string | undefined) {
  const focused = useScreenFocused();
  return useQuery<MMatchDetail>({
    queryKey: ["match", id],
    queryFn: () => api(`/api/mobile/v1/matches/${id}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (focused && q.state.data && ["live", "paused", "pending_sync"].includes(q.state.data.match.status) ? 3_000 : focused ? 15_000 : false),
  });
}

/**
 * Point by point. `version` (status and last event number) changes whenever the
 * match moves, so the timeline is fetched again then too: the final point still
 * reaches the momentum line and game-by-game after the match stops being live.
 */
export function useTimeline(id: string | undefined, live: boolean, version?: string) {
  const focused = useScreenFocused();
  const q = useQuery<MTimeline>({
    queryKey: ["timeline", id],
    queryFn: () => api<MTimeline>(`/api/mobile/v1/matches/${id}/timeline`),
    enabled: Boolean(id),
    refetchInterval: focused && live ? 10_000 : false,
  });
  const { refetch } = q;
  const seen = useRef(version);
  useEffect(() => {
    if (!id || version === undefined || seen.current === version) return;
    const first = seen.current === undefined;
    seen.current = version;
    if (!first) void refetch();
  }, [id, version, refetch]);
  return q;
}

export function useCheers(tieId: string | undefined, live: boolean) {
  const focused = useScreenFocused();
  return useQuery<{ cheers: { nation: string; count: number }[] }>({
    queryKey: ["cheers", tieId],
    queryFn: () => api(`/api/mobile/v1/ties/${tieId}/cheers`),
    enabled: Boolean(tieId),
    refetchInterval: focused && live ? 6_000 : false,
  });
}
