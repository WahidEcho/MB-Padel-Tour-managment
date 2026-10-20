/**
 * Notices on screen: the play status the organiser sets (rain delay, play
 * suspended, play resumed) and the latest major announcement, as one banner
 * model for the app's tournament page and the public web header. Pure and
 * framework-free (shared with the app through `@core`).
 *
 * Stored without a migration in `tournaments.branding_config.playStatus`
 * (written with updateBranding's compare-and-set) and sent additively on the
 * live feed as `MLive.playStatus` (absent from older servers; 1.0.1 ignores it).
 */

export const PLAY_STATUS_KINDS = ["normal", "delayed", "suspended", "resumed"] as const;
export type PlayStatusKind = (typeof PLAY_STATUS_KINDS)[number];

/** What the organiser saved (branding_config.playStatus). */
export interface PlayStatusConfig {
  kind: PlayStatusKind;
  message?: string | null;
  /** When play should start again, as an instant; shown as "Resume about 15:30". */
  resumeAt?: string | null;
  updatedAt: string;
}

/** What viewers get on the live feed: never "normal" (no banner then). */
export interface MPlayStatus {
  kind: Exclude<PlayStatusKind, "normal">;
  message: string | null;
  resumeAt: string | null;
  updatedAt: string;
}

export const MAX_PLAY_STATUS_MESSAGE = 200;
/** "Play resumed" stays up this long, then the banner goes by itself. */
export const RESUMED_SHOWN_MS = 2 * 60 * 60 * 1000;
/** A delay or suspension nobody cleared stops showing after a day. */
export const STATUS_STALE_MS = 24 * 60 * 60 * 1000;
/** A major announcement is a banner for this long after it is published. */
export const MAJOR_NOTICE_MS = 6 * 60 * 60 * 1000;

export const PLAY_STATUS_TITLES: Record<Exclude<PlayStatusKind, "normal">, string> = {
  delayed: "Play delayed",
  suspended: "Play suspended",
  resumed: "Play resumed",
};

export const PLAY_STATUS_LABELS: Record<PlayStatusKind, string> = {
  normal: "Normal (no banner)",
  delayed: "Delayed (amber)",
  suspended: "Suspended (red)",
  resumed: "Resumed (green)",
};

export function isPlayStatusKind(x: unknown): x is PlayStatusKind {
  return typeof x === "string" && (PLAY_STATUS_KINDS as readonly string[]).includes(x);
}

/** The stored status as viewers see it now, or null when there is no banner. */
export function publicPlayStatus(cfg: PlayStatusConfig | null | undefined, now = Date.now()): MPlayStatus | null {
  if (!cfg || !isPlayStatusKind(cfg.kind) || cfg.kind === "normal") return null;
  const at = Date.parse(cfg.updatedAt);
  if (Number.isNaN(at)) return null;
  const age = now - at;
  if (cfg.kind === "resumed" ? age > RESUMED_SHOWN_MS : age > STATUS_STALE_MS) return null;
  const message = typeof cfg.message === "string" && cfg.message.trim() ? cfg.message.trim().slice(0, MAX_PLAY_STATUS_MESSAGE) : null;
  const resumeAt = cfg.kind !== "resumed" && cfg.resumeAt && !Number.isNaN(Date.parse(cfg.resumeAt)) ? cfg.resumeAt : null;
  return { kind: cfg.kind, message, resumeAt, updatedAt: cfg.updatedAt };
}

export type NoticeTone = "delayed" | "suspended" | "resumed" | "major";

export interface NoticeBanner {
  key: string;
  tone: NoticeTone;
  title: string;
  body: string | null;
  /** For the play status: when play should start again. */
  resumeAt: string | null;
  at: string;
}

interface AnnouncementLike {
  id: string;
  title: string;
  body: string | null;
  level: string;
  publishedAt: string;
}

/** The newest major announcement published in the last few hours, if any. */
export function currentMajorAnnouncement<T extends AnnouncementLike>(list: T[] | null | undefined, now = Date.now()): T | null {
  let best: T | null = null;
  for (const a of list ?? []) {
    if (a.level !== "major") continue;
    const at = Date.parse(a.publishedAt);
    if (Number.isNaN(at) || at > now + 60_000 || now - at > MAJOR_NOTICE_MS) continue;
    if (!best || at > Date.parse(best.publishedAt)) best = a;
  }
  return best;
}

/** The banners for a tournament page: the play status first, then the major announcement. */
export function noticeBanners(o: { playStatus?: MPlayStatus | null; announcements?: AnnouncementLike[] | null; now?: number }): NoticeBanner[] {
  const now = o.now ?? Date.now();
  const out: NoticeBanner[] = [];
  const s = o.playStatus;
  if (s && s.kind) {
    out.push({ key: `status:${s.updatedAt}`, tone: s.kind, title: PLAY_STATUS_TITLES[s.kind], body: s.message, resumeAt: s.resumeAt, at: s.updatedAt });
  }
  const a = currentMajorAnnouncement(o.announcements, now);
  if (a) out.push({ key: `ann:${a.id}`, tone: "major", title: a.title, body: a.body, resumeAt: null, at: a.publishedAt });
  return out;
}

/** "Resume about 15:30" (the caller formats the time in the event's zone). */
export function resumeLine(clock: string | null): string | null {
  return clock ? `Play expected to resume about ${clock}` : null;
}

/** The push followers get when the organiser asks for one. */
export function playStatusPush(o: { kind: Exclude<PlayStatusKind, "normal">; eventName: string; message: string | null; resumeClock: string | null }): { title: string; body: string } {
  const title = `${PLAY_STATUS_TITLES[o.kind]} · ${o.eventName}`.slice(0, 120);
  const body = [o.message, o.kind !== "resumed" ? resumeLine(o.resumeClock) : null].filter(Boolean).join(". ");
  return { title, body: (body || (o.kind === "resumed" ? "Play is under way again." : "Follow the event page for updates.")).slice(0, 600) };
}

/** Checks what the admin form posts. A problem message, or null when it is fine. */
export function playStatusProblem(o: { kind: unknown; message: string; resumeAt: string | null }): string | null {
  if (!isPlayStatusKind(o.kind)) return "Pick a play status.";
  if (o.message.length > MAX_PLAY_STATUS_MESSAGE) return `Keep the message to ${MAX_PLAY_STATUS_MESSAGE} characters.`;
  if (o.resumeAt && Number.isNaN(Date.parse(o.resumeAt))) return "Enter the resume time as HH:MM.";
  return null;
}
