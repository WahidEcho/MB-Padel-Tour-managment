"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import {
  addEntryForProfile,
  approveEntry,
  autoPair,
  createFriendlySession,
  finalizeSession,
  generateNextMexicanoRound,
  generateSchedule,
  generateSessionGroupStage,
  generateSessionKnockout,
  promoteFromWaitlist,
  releaseEntry,
  reopenSession,
  setFixedPairs,
  setSessionStatus,
} from "@/lib/friendly/ops";
import { listActivePairs } from "@/lib/friendly/data";
import type { PairingMode, RankingModel } from "@/lib/types";

const PAIRING_MODES: PairingMode[] = ["fixed", "americano", "mexicano"];
const RANKING_MODELS: RankingModel[] = ["win_points", "games_won"];

export async function createSessionAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Session name is required");

  const pairingMode = String(formData.get("pairing_mode") ?? "fixed") as PairingMode;
  if (!PAIRING_MODES.includes(pairingMode)) throw new Error("Unknown pairing mode");

  const rankingModel = String(formData.get("ranking_model") ?? "win_points") as RankingModel;
  if (!RANKING_MODELS.includes(rankingModel)) throw new Error("Unknown ranking model");

  const num = (key: string, fallback: number) => {
    const v = parseInt(String(formData.get(key) ?? ""), 10);
    return Number.isFinite(v) ? v : fallback;
  };

  const startsAtRaw = String(formData.get("starts_at") ?? "").trim();
  const deadlineRaw = String(formData.get("registration_deadline") ?? "").trim();
  const maxPlayersRaw = String(formData.get("max_players") ?? "").trim();
  const seasonId = String(formData.get("season_id") ?? "").trim() || null;

  const durationRaw = String(formData.get("duration_minutes") ?? "").trim();
  const regMode = String(formData.get("registration_mode") ?? "individual");
  const scoreMode = String(formData.get("scoring_mode") ?? "point_by_point");

  const session = await createFriendlySession({
    name,
    seasonId,
    startsAt: startsAtRaw ? new Date(startsAtRaw).toISOString() : null,
    // Empty means no time box at all.
    durationMinutes: durationRaw ? Math.max(1, num("duration_minutes", 120)) : null,
    registrationMode: (["individual", "team", "either"].includes(regMode)
      ? regMode
      : "individual") as "individual" | "team" | "either",
    scoringMode: (["point_by_point", "final_score"].includes(scoreMode)
      ? scoreMode
      : "point_by_point") as "point_by_point" | "final_score",
    courtCount: num("courts", 2),
    pairingMode,
    rankingModel,
    // Rotation formats default to a single set so a 2-hour window fits
    // several rounds; fixed partners can afford best-of-three.
    setsToWinMatch: num("sets_to_win", pairingMode === "fixed" ? 1 : 1),
    gamesToWinSet: num("games_to_win", 6),
    maxPlayers: maxPlayersRaw ? num("max_players", 0) || null : null,
    registrationDeadline: deadlineRaw ? new Date(deadlineRaw).toISOString() : null,
    actorRole: role,
  });

  revalidatePath("/admin/friendly-sessions");
  redirect(`/admin/friendly-sessions/${session.id}`);
}

export async function setStatusAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");
  const sessionId = String(formData.get("session_id") ?? "");
  const status = String(formData.get("status") ?? "");
  const allowed = ["draft", "open", "scheduled", "live", "completed", "finalized"];
  if (!sessionId || !allowed.includes(status)) throw new Error("Invalid session status");

  await setSessionStatus(sessionId, status as "draft", role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
  revalidatePath("/admin/friendly-sessions");
}

export async function approveEntryAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");
  const entryId = String(formData.get("entry_id") ?? "");
  const sessionId = String(formData.get("session_id") ?? "");
  if (!entryId) throw new Error("Registration is required");

  await approveEntry(entryId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function releaseEntryAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");
  const entryId = String(formData.get("entry_id") ?? "");
  const sessionId = String(formData.get("session_id") ?? "");
  const next = String(formData.get("next") ?? "rejected");
  if (!entryId) throw new Error("Registration is required");
  if (next !== "rejected" && next !== "withdrawn") throw new Error("Invalid action");

  await releaseEntry(entryId, next, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function promoteWaitlistAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");
  const sessionId = String(formData.get("session_id") ?? "");
  if (!sessionId) throw new Error("Session is required");

  await promoteFromWaitlist(sessionId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function generateScheduleAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");
  const sessionId = String(formData.get("session_id") ?? "");
  if (!sessionId) throw new Error("Session is required");

  const format = String(formData.get("format") ?? "rotating");
  const fitToTime = formData.get("fit") === "on";

  if (format === "group_stage") {
    const groups = Math.max(1, parseInt(String(formData.get("group_count") ?? "2"), 10) || 2);
    await generateSessionGroupStage(sessionId, groups, role);
  } else if (format === "knockout") {
    await generateSessionKnockout(sessionId, role);
  } else {
    await generateSchedule(sessionId, role, { fit: fitToTime ? "fit" : "all" });
  }

  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function nextRoundAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");
  const sessionId = String(formData.get("session_id") ?? "");
  if (!sessionId) throw new Error("Session is required");

  await generateNextMexicanoRound(sessionId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function autoPairAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");
  const sessionId = String(formData.get("session_id") ?? "");
  if (!sessionId) throw new Error("Session is required");

  await autoPair(sessionId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

/** Called from the drag-and-drop pairing board with typed args. */
export async function savePairsAction(sessionId: string, couples: [string, string][]) {
  const role = await requirePermission("manage_sessions");
  if (!sessionId) throw new Error("Session is required");

  await setFixedPairs(sessionId, couples, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function finalizeSessionAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");
  const sessionId = String(formData.get("session_id") ?? "");
  if (!sessionId) throw new Error("Session is required");

  await finalizeSession(sessionId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
  revalidatePath("/admin/rankings");
}

export async function reopenSessionAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");
  const sessionId = String(formData.get("session_id") ?? "");
  if (!sessionId) throw new Error("Session is required");

  await reopenSession(sessionId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
  revalidatePath("/admin/rankings");
}

/**
 * Add several players at once from the picker dialog.
 * When `pairThem` is set, selection order is the pairing: picks 1+2 become a
 * team, 3+4 the next, and so on — matching the colour coding in the dialog.
 */
export async function addPlayersAction(
  sessionId: string,
  profileIds: string[],
  pairThem: boolean
) {
  const role = await requirePermission("manage_sessions");
  if (!sessionId) throw new Error("Session is required");
  if (profileIds.length === 0) throw new Error("Pick at least one player");
  if (pairThem && profileIds.length % 2 !== 0) {
    throw new Error("Fixed-partner sessions need an even number of players");
  }

  for (const id of profileIds) {
    await addEntryForProfile(sessionId, id, role);
  }

  if (pairThem) {
    // Keep any pairs that already exist, then append the new couples.
    const existing = await listActivePairs(sessionId, 1);
    const couples: [string, string][] = existing
      .filter((p) => p.player_two_profile_id)
      .map((p) => [p.player_one_profile_id, p.player_two_profile_id!]);

    for (let i = 0; i + 1 < profileIds.length; i += 2) {
      couples.push([profileIds[i], profileIds[i + 1]]);
    }
    await setFixedPairs(sessionId, couples, role);
  }

  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function addPlayerAction(formData: FormData) {
  const role = await requirePermission("manage_sessions");
  const sessionId = String(formData.get("session_id") ?? "");
  const profileId = String(formData.get("player_profile_id") ?? "");
  if (!sessionId || !profileId) throw new Error("Session and player are required");

  await addEntryForProfile(sessionId, profileId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}
