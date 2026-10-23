/**
 * Live video per court: what the organiser stored (branding_config.liveVideo)
 * and what viewers are told. Pure and framework-free (shared with the app
 * through @core).
 *
 * A court's video reaches viewers only while it is switched on, its id is a
 * valid YouTube id and the court is one of the tournament's active courts. A
 * match carries it only while it is in play on that court, so a badge never
 * promises video of a match that is not on camera.
 */
import type { BrandingConfig, LiveVideoConfig, LiveVideoCourtConfig } from "../types";
import type { MLiveVideo } from "../mobile/contract";
import { isYouTubeId } from "./youtube";

export const MAX_DELAY_SECONDS = 120;
export const MAX_OVERLAY_TITLE = 60;
const IN_PLAY = new Set(["live", "paused"]);

function cleanCourt(c: unknown): LiveVideoCourtConfig | null {
  if (!c || typeof c !== "object") return null;
  const r = c as Record<string, unknown>;
  if (!isYouTubeId(r.youtubeId)) return null;
  const delay = typeof r.delaySeconds === "number" && Number.isFinite(r.delaySeconds) ? Math.round(r.delaySeconds) : undefined;
  return {
    youtubeId: r.youtubeId,
    on: r.on === true,
    ...(delay !== undefined && delay >= 0 && delay <= MAX_DELAY_SECONDS ? { delaySeconds: delay } : {}),
    ...(r.boardInStream === true ? { boardInStream: true } : {}),
    ...(typeof r.updatedAt === "string" ? { updatedAt: r.updatedAt } : {}),
  };
}

/** The stored settings, cleaned: bad entries are dropped, never trusted. */
export function liveVideoConfig(branding: BrandingConfig | null | undefined): Required<Pick<LiveVideoConfig, "courts">> & { overlayTitle: string } {
  const raw = (branding?.liveVideo ?? {}) as LiveVideoConfig;
  const courts: Record<string, LiveVideoCourtConfig> = {};
  if (raw.courts && typeof raw.courts === "object") {
    for (const [id, c] of Object.entries(raw.courts)) {
      const clean = cleanCourt(c);
      if (clean) courts[id] = clean;
    }
  }
  const title = typeof raw.overlayTitle === "string" ? raw.overlayTitle.trim().slice(0, MAX_OVERLAY_TITLE) : "";
  return { courts, overlayTitle: title };
}

/** The courts streamed right now, by court id. */
export function activeLiveVideos(
  branding: BrandingConfig | null | undefined,
  courts: { id: string; name: string; is_active?: boolean | null }[],
): Map<string, MLiveVideo> {
  const cfg = liveVideoConfig(branding);
  const out = new Map<string, MLiveVideo>();
  for (const court of courts) {
    if (court.is_active === false) continue;
    const c = cfg.courts[court.id];
    if (!c?.on) continue;
    out.set(court.id, {
      youtubeId: c.youtubeId,
      court: court.name,
      courtId: court.id,
      ...(c.delaySeconds !== undefined ? { delaySeconds: c.delaySeconds } : {}),
    });
  }
  return out;
}

/** A match's live video: only while it is in play on a streamed court. */
export function liveVideoForMatch(
  m: { status: string; courtId?: string | null; court_id?: string | null },
  videos: Map<string, MLiveVideo>,
): MLiveVideo | undefined {
  const court = m.courtId ?? m.court_id ?? null;
  if (!court || !IN_PLAY.has(m.status)) return undefined;
  return videos.get(court);
}

/** The match with its `liveVideo` added when it has one; the same object otherwise (no empty key). */
export function withLiveVideo<T extends { status: string; courtId: string | null }>(m: T, videos: Map<string, MLiveVideo>): T & { liveVideo?: MLiveVideo } {
  const v = liveVideoForMatch(m, videos);
  return v ? { ...m, liveVideo: v } : m;
}

/** Branding without the live video settings: what a public page may be handed. */
export function withoutLiveVideo<B extends BrandingConfig | null | undefined>(branding: B): B {
  if (!branding || !("liveVideo" in branding)) return branding;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { liveVideo, ...rest } = branding;
  return rest as B;
}

/** The viewers' line under the player. */
export function delayNote(v: Pick<MLiveVideo, "delaySeconds"> | null | undefined): string {
  const d = v?.delaySeconds;
  return d && d > 0
    ? `The video runs about ${d} s behind the live score.`
    : "The video runs a few seconds behind the live score.";
}
