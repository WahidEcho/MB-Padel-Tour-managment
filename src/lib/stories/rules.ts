/**
 * Move Score Stories: the pure rules (no database, no React), shared with the app
 * through `@core`. Server: src/lib/stories/server.ts; routes under
 * src/app/api/mobile/v1/stories; app: move-score-app/src/stories.
 *
 * A story is one picture made in the app's story composer (1080×1920 JPEG, always
 * with a match, tie or pass card on it), tied to the public event it came from.
 * It is live at once and gone 24 hours after posting. Viewers can report it (three
 * different accounts hide it until staff decide) and block the poster.
 */

/** A story's lifetime from posting. */
export const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Distinct reports that hide a story until staff restore or remove it. */
export const STORY_REPORTS_TO_HIDE = 3;
/** Posts per account per day. */
export const STORY_POSTS_PER_DAY = 20;
/** The exported picture: JPEG, at most 2 MB, about 1080×1920. */
export const STORY_MAX_BYTES = 2 * 1024 * 1024;
export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;
/** How long the viewer shows one story. */
export const STORY_SHOW_MS = 6_000;

export const STORY_REPORT_REASONS = ["spam", "nudity", "harassment", "hate", "violence", "false", "other"] as const;
export type StoryReportReason = (typeof STORY_REPORT_REASONS)[number];

export const STORY_KINDS = ["match", "tie", "pass"] as const;
export type StoryPostKind = (typeof STORY_KINDS)[number];

/* ---------------- what the app sends ---------------- */

/** Where the picture came from, as the share screen knows it. */
export type StoryContextInput =
  | { kind: "match"; matchId: string }
  | { kind: "tie"; tieId: string; slug?: string }
  | { kind: "pass"; slug: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/;

export const isStoryId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** The context of a POST, or null when it is not one we know. */
export function parseStoryContext(v: unknown): StoryContextInput | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "match" && isStoryId(o.matchId)) return { kind: "match", matchId: o.matchId };
  if (o.kind === "tie" && isStoryId(o.tieId)) {
    return typeof o.slug === "string" && SLUG.test(o.slug) ? { kind: "tie", tieId: o.tieId, slug: o.slug } : { kind: "tie", tieId: o.tieId };
  }
  if (o.kind === "pass" && typeof o.slug === "string" && SLUG.test(o.slug)) return { kind: "pass", slug: o.slug };
  return null;
}

export const isReportReason = (v: unknown): v is StoryReportReason => typeof v === "string" && (STORY_REPORT_REASONS as readonly string[]).includes(v);

/* ---------------- the picture ---------------- */

export type StoryImageProblem = "empty" | "type" | "size" | "shape";

/**
 * Whether the bytes are a story export: JPEG only, at most 2 MB, portrait 9:16
 * between 720 and 1440 px wide (the export is 1080×1920; a phone that caps the
 * capture may make it a little smaller).
 */
export function storyImageProblem(img: { type: string | null; bytes: number; width: number | null; height: number | null }): StoryImageProblem | null {
  if (!img.bytes) return "empty";
  if (img.type !== "image/jpeg") return "type";
  if (img.bytes > STORY_MAX_BYTES) return "size";
  const { width, height } = img;
  if (!width || !height) return "shape";
  if (width < 720 || width > 1440) return "shape";
  const ratio = height / width;
  if (Math.abs(ratio - STORY_HEIGHT / STORY_WIDTH) > 0.03) return "shape";
  return null;
}

/* ---------------- moderation ---------------- */

export interface StoryLifeState {
  expires_at: string;
  hidden_at: string | null;
  removed_at: string | null;
}

/** Shown to viewers: not removed, not hidden, not expired. */
export function isLiveStory(s: StoryLifeState, nowMs = Date.now()): boolean {
  return !s.removed_at && !s.hidden_at && Date.parse(s.expires_at) > nowMs;
}

/** When a story posted now expires. */
export function storyExpiry(postedMs: number): string {
  return new Date(postedMs + STORY_LIFETIME_MS).toISOString();
}

/**
 * Whether the reports since staff last restored the story (all of them when never
 * restored) hide it.
 */
export function reportsHide(reportTimes: string[], restoredAt: string | null): boolean {
  const since = restoredAt ? Date.parse(restoredAt) : -Infinity;
  return reportTimes.filter((t) => Date.parse(t) > since).length >= STORY_REPORTS_TO_HIDE;
}

/** The caption under a story: plain text, one line, at most 140 characters. */
export function cleanCaption(parts: (string | null | undefined)[]): string | null {
  const text = parts
    .map((p) => (p ?? "").replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
  if (!text) return null;
  return text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
}

/* ---------------- what the server answers ---------------- */

/** One story in a feed. Never the poster's account id: `poster` is an opaque key. */
export interface MStory {
  id: string;
  imageUrl: string;
  kind: StoryPostKind;
  createdAt: string;
  expiresAt: string;
  /** "EGY v JPN · Junior Finals": what it came from, tappable. */
  caption: string | null;
  /** Opens the match, the tie or the event. */
  link: { matchId: string | null; tieId: string | null; slug: string };
  /** Per-account feeds only: this account liked it. */
  liked?: boolean;
  /** Per-account feeds only: the account's own story, with its counts (the poster alone sees them). */
  mine?: boolean;
  likes?: number;
  views?: number;
}

export interface MStoryPoster {
  /** Opaque, stable per account (an HMAC): groups the circles, never an account id. */
  key: string;
  name: string | null;
  avatarUrl: string | null;
  /** Oldest first, the order they play in. */
  stories: MStory[];
}

export interface MStoryFeed {
  generatedAt: string;
  /** Newest poster first. */
  posters: MStoryPoster[];
}

export interface MBlockedPoster {
  key: string;
  name: string | null;
}

export interface MMyStories {
  stories: MStory[];
  blocked: MBlockedPoster[];
  /** False when the account is banned from posting. */
  canPost: boolean;
}

/* ---------------- the row of circles ---------------- */

/**
 * The circles in order: posters with a story this phone has not seen first, then
 * the rest; inside each, the newest story first. The phone's own posts (`mine`)
 * stay out of the row (the "+" circle stands for them).
 */
export function orderPosters(posters: MStoryPoster[], seen: ReadonlySet<string>): MStoryPoster[] {
  const newest = (p: MStoryPoster) => p.stories.reduce((m, s) => (s.createdAt > m ? s.createdAt : m), "");
  const unseen = (p: MStoryPoster) => p.stories.some((s) => !seen.has(s.id));
  return [...posters].sort((a, b) => Number(unseen(b)) - Number(unseen(a)) || newest(b).localeCompare(newest(a)));
}

/** Where a poster's stories start playing: the first one not seen yet, else the first. */
export function firstUnseen(p: MStoryPoster, seen: ReadonlySet<string>): number {
  const i = p.stories.findIndex((s) => !seen.has(s.id));
  return i === -1 ? 0 : i;
}

/** Groups live stories (oldest first per poster) into posters, newest poster first. */
export function groupPosters<T extends { posterKey: string; posterName: string | null; posterAvatar: string | null; story: MStory }>(rows: T[]): MStoryPoster[] {
  const byKey = new Map<string, MStoryPoster>();
  const sorted = [...rows].sort((a, b) => a.story.createdAt.localeCompare(b.story.createdAt));
  for (const r of sorted) {
    let p = byKey.get(r.posterKey);
    if (!p) byKey.set(r.posterKey, (p = { key: r.posterKey, name: r.posterName, avatarUrl: r.posterAvatar, stories: [] }));
    // The newest story's name and photo win.
    p.name = r.posterName ?? p.name;
    p.avatarUrl = r.posterAvatar ?? p.avatarUrl;
    p.stories.push(r.story);
  }
  return orderPosters([...byKey.values()], new Set());
}

/** "5m", "3h": how long ago, for the viewer's header (minutes under an hour, then hours). */
export function storyAge(createdAt: string, nowMs = Date.now()): { unit: "now" | "m" | "h"; n: number } {
  const min = Math.floor((nowMs - Date.parse(createdAt)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return { unit: "now", n: 0 };
  if (min < 60) return { unit: "m", n: min };
  return { unit: "h", n: Math.min(24, Math.floor(min / 60)) };
}
