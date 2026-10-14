/**
 * Server state. Every public read is the same URL for every phone, polled only
 * while the screen is on and focused, so the CDN can share one copy between
 * everyone in the venue.
 */
import { QueryClient, focusManager, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { AppState, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MBundle, MConfig, MCourtsLive, MDiscover, MJoinResult, MLeague, MLeagueReveal, MLive, MMatchDetail, MMyLeagues, MMyRegistrations, MOrgProfile, MPaymentChoice, MRegistrationInfo, MRegistrationResult, MStandings, MTimeline, MTopBoard } from "@core";
import { ApiError, api } from "./client";
import { checkNetwork, watchNetwork } from "./network";
import { getJson, setJson } from "../state/kv";
import { session } from "../state/session";

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
  AppState.addEventListener("change", (s) => {
    // Back in the hand: ask about the connection again (a change can be missed asleep).
    if (s === "active") void checkNetwork();
    focusManager.setFocused(s === "active");
  });
}
// With no signal, reads pause instead of failing and run again the moment the phone is
// back online (api/network.ts). Saved answers stay on screen under an "Offline · showing
// scores from …" banner (ui/Offline.tsx); a page with nothing saved shows ui/LoadState.tsx.
watchNetwork();

/** Pull-to-refresh on a page built from several tournaments: every read on screen, again. */
export const refetchOnScreen = () => queryClient.refetchQueries({ type: "active" });

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

/**
 * A public read first (the shared, CDN-cached URL). When that is a 404 and someone
 * is signed in, the same read on the account's own path (GET /api/mobile/v1/me/…,
 * never cached), which also serves a 'Members only' or 'Invite only' league and
 * its nights to the people who may see them. Only a public answer is kept on the
 * phone: a per-account one is not left behind for whoever uses the phone next.
 */
function publicOrMine<T>(key: string | null, publicPath: string, minePath: string): () => Promise<T> {
  return async () => {
    try {
      const v = await api<T>(publicPath);
      if (key) setJson(`q:${key}`, v);
      return v;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404) || !session.get().user) throw e;
      return api<T>(minePath, { who: "me" });
    }
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

/**
 * The live courts hero on Discover: every court of the featured event and the live
 * tournaments, in one shared (CDN-cached) read. Polled like a live feed while
 * Discover is on screen; `enabled` is the platform flag. The last answer is kept
 * so the hero is there at once when the app opens on a live day.
 */
export function useCourtsLive(enabled: boolean, intervalMs = 5_000) {
  const focused = useScreenFocused();
  return useQuery<MCourtsLive>({
    queryKey: ["courts-live"],
    queryFn: cached("courts-live", () => api<MCourtsLive>("/api/mobile/v1/courts/live")),
    initialData: () => initial<MCourtsLive>("courts-live"),
    ...SAVED_IS_OLD,
    enabled,
    refetchInterval: focused && enabled ? intervalMs : false,
  });
}

export function useBundle(slug: string | undefined, opts: Opts<MBundle> = {}) {
  return useQuery<MBundle>({
    queryKey: ["bundle", slug],
    queryFn: publicOrMine<MBundle>(`bundle:${slug}`, `/api/mobile/v1/t/${slug}/bundle`, `/api/mobile/v1/me/t/${slug}/bundle`),
    initialData: () => (slug ? initial<MBundle>(`bundle:${slug}`) : undefined),
    ...SAVED_IS_OLD,
    enabled: Boolean(slug),
    staleTime: 60_000,
    ...opts,
  });
}

/** An organisation's public page (profile, branding, tournaments). Kept on the phone like a bundle. */
export function useOrg(slug: string | undefined) {
  return useQuery<MOrgProfile>({
    queryKey: ["org", slug],
    queryFn: cached(`org:${slug}`, () => api<MOrgProfile>(`/api/mobile/v1/orgs/${encodeURIComponent(slug ?? "")}`)),
    initialData: () => (slug ? initial<MOrgProfile>(`org:${slug}`) : undefined),
    ...SAVED_IS_OLD,
    enabled: Boolean(slug),
    staleTime: 60_000,
  });
}

/* ---------- leagues (Phase 7) ---------- */

/** A league's public page; `period` 1/3/6/9/12 months ending in `month` ("YYYY-MM", default this month). */
export function useLeague(slug: string | undefined, period = 1, month?: string) {
  const focused = useScreenFocused();
  const qs = `?period=${period}${month ? `&month=${month}` : ""}`;
  const key = `league:${slug}:${period}:${month ?? "now"}`;
  return useQuery<MLeague>({
    queryKey: ["league", slug, period, month ?? null],
    queryFn: publicOrMine<MLeague>(key, `/api/mobile/v1/leagues/${encodeURIComponent(slug ?? "")}${qs}`, `/api/mobile/v1/me/leagues/${encodeURIComponent(slug ?? "")}${qs}`),
    initialData: () => (slug ? initial<MLeague>(key) : undefined),
    ...SAVED_IS_OLD,
    enabled: Boolean(slug),
    refetchInterval: focused ? 30_000 : false,
  });
}

/** "Top of all leagues" across the platform for a month (default this month). */
export function useTopBoard(month?: string) {
  const key = `top:${month ?? "now"}`;
  return useQuery<MTopBoard>({
    queryKey: ["top-board", month ?? null],
    queryFn: cached(key, () => api<MTopBoard>(`/api/mobile/v1/leagues/top${month ? `?month=${month}` : ""}`)),
    initialData: () => initial<MTopBoard>(key),
    ...SAVED_IS_OLD,
    staleTime: 60_000,
  });
}

/**
 * The signed-in account's leagues: status, division and this month's rank in
 * each (`slug` narrows to one league). Never shared: it rides on the account's
 * token. Also the data a league widget will read (Phase 6 widgets).
 */
export function useMyLeagues(enabled: boolean, slug?: string) {
  return useQuery<MMyLeagues>({
    queryKey: ["my-leagues", slug ?? null],
    queryFn: () => api<MMyLeagues>(`/api/mobile/v1/me/leagues${slug ? `?league=${encodeURIComponent(slug)}` : ""}`, { who: "me" }),
    enabled,
    staleTime: 15_000,
  });
}

/** Joins (or asks to join) a league as the account's linked player. Throws ApiError with the server's reason. */
export async function joinLeague(slug: string, body: { code?: string; divisionId?: string }): Promise<MJoinResult> {
  const out = await api<MJoinResult>(`/api/mobile/v1/leagues/${encodeURIComponent(slug)}/join`, { method: "POST", body, who: "me" });
  await queryClient.invalidateQueries({ queryKey: ["my-leagues"] });
  await queryClient.invalidateQueries({ queryKey: ["league", slug] });
  return out;
}

/**
 * Enters a league's invite code: the league it belongs to opens for this account
 * (an 'Invite only' one included). Throws ApiError (404 code "invite_code_wrong",
 * 429 "too_many") with the server's words.
 */
export async function revealLeague(code: string): Promise<MLeagueReveal> {
  const out = await api<MLeagueReveal>("/api/mobile/v1/leagues/code", { method: "POST", body: { code }, who: "me" });
  await queryClient.invalidateQueries({ queryKey: ["my-leagues"] });
  await queryClient.invalidateQueries({ queryKey: ["league", out.slug] });
  return out;
}

/* ---------- registration and payment (Phase 9) ---------- */

/** How to register for an event; a 404 means it takes no registrations here. */
export function useRegistrationInfo(slug: string | undefined) {
  return useQuery<MRegistrationInfo>({
    queryKey: ["registration-info", slug],
    queryFn: () => api<MRegistrationInfo>(`/api/mobile/v1/t/${encodeURIComponent(slug!)}/registration`),
    enabled: Boolean(slug),
    staleTime: 15_000,
  });
}

export function useMyRegistrations(enabled: boolean) {
  return useQuery<MMyRegistrations>({
    queryKey: ["my-registrations"],
    queryFn: () => api<MMyRegistrations>("/api/mobile/v1/me/registrations", { who: "me" }),
    enabled,
    staleTime: 5_000,
  });
}

export async function registerFor(
  slug: string,
  body: { people: { name: string; phone?: string; email?: string }[]; teamName?: string; payment: MPaymentChoice },
): Promise<MRegistrationResult> {
  const out = await api<MRegistrationResult>(`/api/mobile/v1/t/${encodeURIComponent(slug)}/registration`, { method: "POST", body, who: "me" });
  await queryClient.invalidateQueries({ queryKey: ["my-registrations"] });
  await queryClient.invalidateQueries({ queryKey: ["registration-info", slug] });
  return out;
}

/** pay (a Move Tick checkout), cancel, or ask the organiser for a refund. */
export async function registrationAction(id: string, kind: "pay" | "cancel" | "refund-request"): Promise<MRegistrationResult> {
  const out = await api<MRegistrationResult>(`/api/mobile/v1/me/registrations/${encodeURIComponent(id)}/${kind}`, { method: "POST", body: {}, who: "me" });
  await queryClient.invalidateQueries({ queryKey: ["my-registrations"] });
  return out;
}

export function useLive(slug: string | undefined, intervalMs = 5_000) {
  const focused = useScreenFocused();
  return useQuery<MLive>({
    queryKey: ["live", slug],
    queryFn: publicOrMine<MLive>(`live:${slug}`, `/api/mobile/v1/t/${slug}/live`, `/api/mobile/v1/me/t/${slug}/live`),
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
    queryFn: publicOrMine<MStandings>(null, `/api/mobile/v1/t/${slug}/standings`, `/api/mobile/v1/me/t/${slug}/standings`),
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
