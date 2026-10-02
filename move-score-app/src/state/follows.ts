/**
 * What this person follows: players, nations, ties, matches. Kept on the phone
 * first (works offline, works as a guest) and mirrored to the server, which is
 * what turns a follow into alerts.
 */
import type { FollowKind, MFollow } from "@core";
import { createStore } from "./store";
import { getJson, setJson } from "./kv";
import { api } from "../api/client";
import { session } from "./session";

const KEY = "ms.follows";
export const follows = createStore<MFollow[]>(getJson<MFollow[]>(KEY, []));
follows.subscribe(() => setJson(KEY, follows.get()));

const k = (kind: FollowKind, key: string) => `${kind}:${key}`;

export function isFollowing(kind: FollowKind, key: string): boolean {
  return follows.get().some((f) => k(f.kind, f.key) === k(kind, key));
}

export function useFollowing(kind: FollowKind, key: string | null | undefined): boolean {
  return follows.use((list) => Boolean(key) && list.some((f) => f.kind === kind && f.key === key));
}

export function useFollowsOf(kind: FollowKind): string[] {
  const list = follows.use((l) => l);
  return list.filter((f) => f.kind === kind).map((f) => f.key);
}

export async function toggleFollow(kind: FollowKind, key: string, tournamentId: string | null) {
  const on = isFollowing(kind, key);
  const f: MFollow = { kind, key, tournamentId };
  follows.set((list) => (on ? list.filter((x) => k(x.kind, x.key) !== k(kind, key)) : [...list, f]));
  // The first follow is when alerts make sense: ask then (once per install).
  // Loaded lazily: push/register imports this module.
  if (!on) void import("../push/ask").then((m) => m.askForAlertsAfterFollow()).catch(() => {});
  try {
    if (session.get().installToken || session.get().user) {
      await api("/api/mobile/v1/me/follows", { who: "me", body: on ? { remove: [f] } : { add: [f] } });
    }
  } catch {
    // Kept locally; the next sync sends it.
  }
}

/** Pushes the phone's follows to the server and takes the server's union back. */
export async function syncFollows(mergeInstall = false) {
  if (!session.get().installToken && !session.get().user) return;
  try {
    const r = await api<{ follows: MFollow[] }>("/api/mobile/v1/me/follows", { who: "me", body: { add: follows.get(), mergeInstall } });
    const seen = new Set(r.follows.map((f) => k(f.kind, f.key)));
    follows.set([...r.follows, ...follows.get().filter((f) => !seen.has(k(f.kind, f.key)))]);
  } catch {
    /* offline: try again later */
  }
}
