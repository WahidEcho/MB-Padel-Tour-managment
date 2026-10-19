"use server";

import { revalidatePath } from "next/cache";
import { requireTournamentPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { entityRefusal, refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { updateBranding } from "@/lib/backgroundStorage";
import { formResult, refusal, type FormState } from "@/lib/refusal";
import { MAX_DELAY_SECONDS, MAX_OVERLAY_TITLE, liveVideoConfig } from "@/lib/stream/liveVideo";
import { YOUTUBE_PARSE_MESSAGES, parseYouTubeUrl } from "@/lib/stream/youtube";
import type { LiveVideoCourtConfig } from "@/lib/types";

/**
 * One court's live video: its YouTube link (stored as the video id), on or off,
 * and about how far the video runs behind the score. Stored in
 * `branding_config.liveVideo.courts[courtId]` (no migration), written with the
 * compare-and-set of updateBranding so a branding save in another tab is kept.
 * The court must be one of this tournament's own (entityRefusal).
 */
export async function saveLiveVideo(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff } = await requireTournamentPermission("manage_tournament", id);
  const courtId = String(formData.get("court_id") ?? "");
  refuse(await entityRefusal(id, "courts", courtId));
  return formResult(async () => {
    const intent = String(formData.get("intent") ?? "save");
    const url = String(formData.get("youtube_url") ?? "").slice(0, 500);
    const on = intent === "remove" ? false : formData.get("on") === "on";
    const delayRaw = String(formData.get("delay_seconds") ?? "").trim();
    const delay = delayRaw === "" ? undefined : Number(delayRaw);
    if (delay !== undefined && (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_SECONDS)) {
      refusal(`The delay is a whole number of seconds from 0 to ${MAX_DELAY_SECONDS}.`);
    }
    let next: LiveVideoCourtConfig | null = null;
    if (intent !== "remove") {
      const parsed = parseYouTubeUrl(url);
      if (!parsed.ok) refusal(YOUTUBE_PARSE_MESSAGES[parsed.reason]);
      next = { youtubeId: parsed.id, on, ...(delay !== undefined ? { delaySeconds: delay } : {}), updatedAt: new Date().toISOString() };
    }
    let before: LiveVideoCourtConfig | null = null;
    const written = await updateBranding(id, (current) => {
      const raw = current.liveVideo ?? {};
      const courts = { ...(raw.courts ?? {}) };
      before = courts[courtId] ?? null;
      if (next) courts[courtId] = next;
      else delete courts[courtId];
      return { ...current, liveVideo: { ...raw, courts } };
    });
    if (!written.ok) refusal("Could not save the live video. Reload the page and try again.");
    await audit({
      tournament_id: id,
      actor_role: staff.role,
      action: "LIVE_VIDEO_EDITED",
      entity_type: "court",
      entity_id: courtId,
      old_value: before,
      new_value: next,
    });
    revalidatePath(`/admin/tournaments/${id}/live-stream`);
    return next ? (next.on ? "Saved. The video is live for viewers of this court." : "Saved. Viewers see nothing until you switch it on.") : "Removed.";
  });
}

/** The overlay's header strip ("DAVIS CUP JUNIORS"); the tournament's name when empty. */
export async function saveOverlayTitle(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff } = await requireTournamentPermission("manage_tournament", id);
  refuse(await tournamentRowRefusal(id));
  return formResult(async () => {
    const title = String(formData.get("overlay_title") ?? "").trim();
    if (title.length > MAX_OVERLAY_TITLE) refusal(`Keep the title to ${MAX_OVERLAY_TITLE} characters.`);
    let before = "";
    const written = await updateBranding(id, (current) => {
      before = liveVideoConfig(current).overlayTitle;
      const raw = current.liveVideo ?? {};
      const nextRaw = { ...raw };
      if (title) nextRaw.overlayTitle = title;
      else delete nextRaw.overlayTitle;
      return { ...current, liveVideo: nextRaw };
    });
    if (!written.ok) refusal("Could not save the title. Reload the page and try again.");
    await audit({
      tournament_id: id,
      actor_role: staff.role,
      action: "OVERLAY_TITLE_EDITED",
      entity_type: "tournament",
      entity_id: id,
      old_value: { overlayTitle: before },
      new_value: { overlayTitle: title },
    });
    revalidatePath(`/admin/tournaments/${id}/live-stream`);
  });
}
