/**
 * Server state. Every public read is the same URL for every phone, polled only
 * while the screen is on and focused, so the CDN can share one copy between
 * everyone in the venue.
 */
import { QueryClient, focusManager, onlineManager, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { AppState, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import type { MBundle, MConfig, MDiscover, MLive, MMatchDetail, MStandings, MTimeline } from "@core";
import { api } from "./client";
import { getJson, setJson } from "../state/kv";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, staleTime: 2_000, gcTime: 30 * 60_000, refetchOnReconnect: true },
  },
});

// Foreground/background drives polling: nothing is fetched while the app is in a pocket.
if (Platform.OS !== "web") {
  AppState.addEventListener("change", (s) => focusManager.setFocused(s === "active"));
}
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
  return useQuery<MConfig>({ queryKey: ["config"], queryFn: cached("config", () => api<MConfig>("/api/mobile/v1/config")), initialData: initial("config"), ...SAVED_IS_OLD, staleTime: 60_000 });
}

export function useDiscover() {
  const focused = useScreenFocused();
  return useQuery<MDiscover>({
    queryKey: ["discover"],
    queryFn: cached("discover", () => api<MDiscover>("/api/mobile/v1/discover")),
    initialData: initial("discover"),
    ...SAVED_IS_OLD,
    refetchInterval: focused ? 30_000 : false,
  });
}

export function useBundle(slug: string | undefined, opts: Opts<MBundle> = {}) {
  return useQuery<MBundle>({
    queryKey: ["bundle", slug],
    queryFn: cached(`bundle:${slug}`, () => api<MBundle>(`/api/mobile/v1/t/${slug}/bundle`)),
    initialData: slug ? initial(`bundle:${slug}`) : undefined,
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
    initialData: slug ? initial(`live:${slug}`) : undefined,
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
    refetchInterval: (q) => (focused && q.state.data && ["live", "paused"].includes(q.state.data.match.status) ? 3_000 : focused ? 15_000 : false),
  });
}

export function useTimeline(id: string | undefined, live: boolean) {
  const focused = useScreenFocused();
  return useQuery<MTimeline>({
    queryKey: ["timeline", id],
    queryFn: () => api<MTimeline>(`/api/mobile/v1/matches/${id}/timeline`),
    enabled: Boolean(id),
    refetchInterval: focused && live ? 10_000 : false,
  });
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
