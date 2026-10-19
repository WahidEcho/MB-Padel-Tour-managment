/**
 * YouTube live video links, as an organiser pastes them. Pure and framework-free
 * (shared with the app through @core).
 *
 * Only the 11-character video id is stored: every link the organiser may paste
 * (watch, live, youtu.be, embed, shorts, the nocookie host, a bare id) comes down
 * to it, and the players build their own URLs from it. A channel's "/live" page
 * names no video, so it is refused with a reason rather than guessed at.
 */

export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export type YouTubeParse =
  | { ok: true; id: string }
  | { ok: false; reason: "empty" | "not_youtube" | "channel_live" | "no_video_id" };

const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** Path forms whose next segment is the video id. */
const ID_SEGMENTS = new Set(["live", "embed", "shorts", "v", "e"]);

export function isYouTubeId(value: unknown): value is string {
  return typeof value === "string" && YOUTUBE_ID_RE.test(value);
}

export function parseYouTubeUrl(input: string | null | undefined): YouTubeParse {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, reason: "empty" };
  if (YOUTUBE_ID_RE.test(raw)) return { ok: true, id: raw };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: "not_youtube" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "not_youtube" };
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return { ok: false, reason: "not_youtube" };
  const parts = url.pathname.split("/").filter(Boolean);

  if (host.endsWith("youtu.be")) {
    return parts[0] && YOUTUBE_ID_RE.test(parts[0]) ? { ok: true, id: parts[0] } : { ok: false, reason: "no_video_id" };
  }
  // youtube.com/watch?v=ID (also /live?v=ID, which YouTube sometimes hands out).
  const v = url.searchParams.get("v");
  if (v && YOUTUBE_ID_RE.test(v)) return { ok: true, id: v };
  if (parts.length >= 2 && ID_SEGMENTS.has(parts[0].toLowerCase()) && YOUTUBE_ID_RE.test(parts[1])) {
    return { ok: true, id: parts[1] };
  }
  // youtube.com/@channel/live, /channel/UC…/live, /c/name/live, /user/name/live: a channel, not a video.
  if (parts[parts.length - 1]?.toLowerCase() === "live" || parts[0]?.startsWith("@") || ["channel", "c", "user"].includes(parts[0] ?? "")) {
    return { ok: false, reason: "channel_live" };
  }
  return { ok: false, reason: "no_video_id" };
}

export const YOUTUBE_PARSE_MESSAGES: Record<Exclude<YouTubeParse, { ok: true }>["reason"], string> = {
  empty: "Paste the YouTube link of this court's live video.",
  not_youtube: "That is not a YouTube link.",
  channel_live:
    "That is the channel's live page, which names no video. In YouTube Studio open this court's live stream and copy its own link (youtube.com/live/… or youtu.be/…).",
  no_video_id: "That YouTube link names no video. Copy the live video's own link (youtube.com/live/…, watch?v=… or youtu.be/…).",
};

/** The page on YouTube itself: the fallback when embedding is off or fails. */
export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

/**
 * The embedded player. The nocookie host sets no tracking cookie until the viewer
 * presses play; `playsinline` keeps an iPhone from going full screen on its own,
 * and the JS API is on so the page can tell "embedding disabled" from a stream
 * that has not started.
 */
export function youtubeEmbedUrl(id: string, opts: { autoplay?: boolean; mute?: boolean; origin?: string } = {}): string {
  const q = new URLSearchParams({ playsinline: "1", rel: "0", modestbranding: "1", enablejsapi: "1" });
  if (opts.autoplay) q.set("autoplay", "1");
  if (opts.mute) q.set("mute", "1");
  if (opts.origin) q.set("origin", opts.origin);
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${q.toString()}`;
}

/** The still YouTube serves for a video (also for a live one): a poster before the player loads. */
export function youtubeThumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

/**
 * What a player error from the IFrame API means for the viewer.
 * 2: bad id; 5: HTML5 player error; 100: removed or private; 101/150/153: the
 * owner does not allow embedding (153 is also "no referrer" on newer players).
 */
export function youtubeErrorKind(code: number): "embedding_disabled" | "unavailable" | "error" {
  if (code === 101 || code === 150 || code === 153) return "embedding_disabled";
  if (code === 100 || code === 2) return "unavailable";
  return "error";
}
