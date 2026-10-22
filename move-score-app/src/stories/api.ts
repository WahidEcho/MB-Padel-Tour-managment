/**
 * Move Score Stories on the phone: the feeds, posting and the reactions.
 *
 * Signed out, the feed is the shared public read (CDN). Signed in, it is the
 * account's own feed (GET /me/stories/feed): the posters it blocked are left out
 * on the server, so their stories never reach this phone.
 */
import { useQuery } from "@tanstack/react-query";
import { Platform } from "react-native";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { STORY_MAX_BYTES, STORY_WIDTH, type MMyStories, type MStory, type MStoryFeed, type StoryContextInput, type StoryReportReason } from "@core";
import { api } from "../api/client";
import { queryClient, useScreenFocused } from "../api/queries";
import { session } from "../state/session";

const feedKey = (slug: string | null | undefined) => ["stories", slug ?? "all"] as const;

/** Every public event's stories (`slug` null) or one event's. */
export function useStoriesFeed(slug?: string | null) {
  const focused = useScreenFocused();
  const signedIn = session.use((s) => Boolean(s.user));
  return useQuery<MStoryFeed>({
    queryKey: [...feedKey(slug), signedIn ? "me" : "public"],
    queryFn: () =>
      signedIn
        ? api<MStoryFeed>(`/api/mobile/v1/me/stories/feed${slug ? `?t=${encodeURIComponent(slug)}` : ""}`, { who: "me" })
        : api<MStoryFeed>(slug ? `/api/mobile/v1/t/${encodeURIComponent(slug)}/stories` : "/api/mobile/v1/stories"),
    refetchInterval: focused ? 60_000 : false,
    staleTime: 10_000,
  });
}

/** The feed as already loaded (the viewer opens on what the row showed). */
export function cachedFeed(slug: string | null | undefined): MStoryFeed | undefined {
  const signedIn = Boolean(session.get().user);
  return queryClient.getQueryData<MStoryFeed>([...feedKey(slug), signedIn ? "me" : "public"]);
}

const refreshFeeds = () => queryClient.invalidateQueries({ queryKey: ["stories"] });

export function useMyStories(enabled: boolean) {
  return useQuery<MMyStories>({ queryKey: ["my-stories"], queryFn: () => api<MMyStories>("/api/mobile/v1/me/stories", { who: "me" }), enabled, staleTime: 10_000 });
}

/** The exported picture as a story upload: a JPEG of about 1080×1920, under 2 MB. */
async function storyJpeg(uri: string): Promise<string> {
  for (const compress of [0.86, 0.72, 0.58]) {
    const ctx = ImageManipulator.manipulate(uri);
    ctx.resize({ width: STORY_WIDTH });
    const out = await (await ctx.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
    if (!out.base64) continue;
    // base64 is 4/3 of the bytes.
    if ((out.base64.length * 3) / 4 <= STORY_MAX_BYTES * 0.97) return out.base64;
  }
  throw new Error("too_large");
}

/** Posts the exported picture (a file, or a data URI on the web) with where it came from. */
export async function postStory(uri: string, context: StoryContextInput): Promise<MStory> {
  const image = Platform.OS === "web" && uri.startsWith("data:image/jpeg") ? uri.replace(/^data:[^;]+;base64,/, "") : await storyJpeg(uri);
  const r = await api<{ story: MStory }>("/api/mobile/v1/stories", { who: "me", body: { image, context }, timeoutMs: 45_000 });
  void refreshFeeds();
  void queryClient.invalidateQueries({ queryKey: ["my-stories"] });
  return r.story;
}

export async function setStoryLike(id: string, liked: boolean): Promise<void> {
  await api(`/api/mobile/v1/stories/${id}/like`, { who: "me", body: { liked } });
}

/** Counted once per account (or per phone signed out); failures do not matter. */
export function markStoryViewed(id: string): void {
  void api(`/api/mobile/v1/stories/${id}/view`, { who: "me", method: "POST" }).catch(() => undefined);
}

export async function reportStory(id: string, reason: StoryReportReason): Promise<void> {
  await api(`/api/mobile/v1/stories/${id}/report`, { who: "me", body: { reason } });
  void refreshFeeds();
}

export async function blockStoryPoster(id: string): Promise<void> {
  await api(`/api/mobile/v1/stories/${id}/block`, { who: "me", method: "POST" });
  void refreshFeeds();
  void queryClient.invalidateQueries({ queryKey: ["my-stories"] });
}

export async function unblockStoryPoster(key: string): Promise<void> {
  await api("/api/mobile/v1/me/stories/blocks", { who: "me", body: { unblock: key } });
  void refreshFeeds();
  void queryClient.invalidateQueries({ queryKey: ["my-stories"] });
}

export async function deleteStory(id: string): Promise<void> {
  await api(`/api/mobile/v1/stories/${id}`, { who: "me", method: "DELETE" });
  void refreshFeeds();
  void queryClient.invalidateQueries({ queryKey: ["my-stories"] });
}
