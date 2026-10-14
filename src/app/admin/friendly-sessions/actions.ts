"use server";

import { formResult, type FormState } from "@/lib/refusal";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { NOT_FOUND, requireScopedPermission, requireStaffPermission } from "@/lib/guard";
import { profilesInOrg } from "@/lib/orgs/scope";
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
import { getSession, listActivePairs } from "@/lib/friendly/data";
import { getTournament } from "@/lib/data";
import { db } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import type { PairingMode, RankingModel } from "@/lib/types";
import { afterNightRoundAdded, publishNightTable } from "@/lib/friendly/nights";
import { enterFinalResult, type EnterResultOutcome } from "@/lib/scoring/append";

/** Every profile named must be one of the organisation's players ("not found" otherwise). */
async function requireOwnPlayers(orgId: string, profileIds: string[]) {
  const ids = [...new Set(profileIds)];
  const own = await profilesInOrg(orgId, ids);
  if (ids.some((id) => !own.has(id))) throw new Error(NOT_FOUND);
}

const PAIRING_MODES: PairingMode[] = ["fixed", "americano", "mexicano"];
const RANKING_MODELS: RankingModel[] = ["win_points", "games_won"];

export async function createSessionAction(formData: FormData) {
  const staff = await requireStaffPermission("manage_sessions");
  const role = staff.role;

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
  // The season must be this organisation's own.
  if (seasonId) await requireScopedPermission("manage_sessions", { season: seasonId });

  const durationRaw = String(formData.get("duration_minutes") ?? "").trim();
  const regMode = String(formData.get("registration_mode") ?? "individual");
  const scoreMode = String(formData.get("scoring_mode") ?? "either");

  const session = await createFriendlySession({
    name,
    seasonId,
    startsAt: startsAtRaw ? new Date(startsAtRaw).toISOString() : null,
    // Empty means no time box at all.
    durationMinutes: durationRaw ? Math.max(1, num("duration_minutes", 120)) : null,
    registrationMode: (["individual", "team", "either"].includes(regMode)
      ? regMode
      : "individual") as "individual" | "team" | "either",
    // "either" (the default): the referee or organiser scores point by point or enters the final result.
    scoringMode: (["point_by_point", "final_score", "either"].includes(scoreMode)
      ? scoreMode
      : "either") as "point_by_point" | "final_score" | "either",
    courtCount: num("courts", 2),
    pairingMode,
    rankingModel,
    // Rotation formats default to a single set so a 2-hour window fits
    // several rounds; fixed partners can afford best-of-three.
    setsToWinMatch: num("sets_to_win", pairingMode === "fixed" ? 1 : 1),
    gamesToWinSet: num("games_to_win", 6),
    maxPlayers: maxPlayersRaw ? num("max_players", 0) || null : null,
    registrationDeadline: deadlineRaw ? new Date(deadlineRaw).toISOString() : null,
    organizationId: staff.orgId,
    actorRole: role,
  });

  revalidatePath("/admin/friendly-sessions");
  redirect(`/admin/friendly-sessions/${session.id}`);
}

export async function setStatusAction(formData: FormData) {
  const sessionId = String(formData.get("session_id") ?? "");
  const role = (await requireScopedPermission("manage_sessions", { session: sessionId })).staff.role;
  const status = String(formData.get("status") ?? "");
  const allowed = ["draft", "open", "scheduled", "live", "completed", "finalized"];
  if (!sessionId || !allowed.includes(status)) throw new Error("Invalid session status");

  await setSessionStatus(sessionId, status as "draft", role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
  revalidatePath("/admin/friendly-sessions");
}

export async function approveEntryAction(formData: FormData) {
  const entryId = String(formData.get("entry_id") ?? "");
  // The registration's own session decides whose it is, not the posted session id.
  const role = (await requireScopedPermission("manage_sessions", { entry: entryId })).staff.role;
  const sessionId = String(formData.get("session_id") ?? "");
  if (!entryId) throw new Error("Registration is required");

  await approveEntry(entryId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function releaseEntryAction(formData: FormData) {
  const entryId = String(formData.get("entry_id") ?? "");
  // The registration's own session decides whose it is, not the posted session id.
  const role = (await requireScopedPermission("manage_sessions", { entry: entryId })).staff.role;
  const sessionId = String(formData.get("session_id") ?? "");
  const next = String(formData.get("next") ?? "rejected");
  if (!entryId) throw new Error("Registration is required");
  if (next !== "rejected" && next !== "withdrawn") throw new Error("Invalid action");

  await releaseEntry(entryId, next, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function promoteWaitlistAction(formData: FormData) {
  const sessionId = String(formData.get("session_id") ?? "");
  const role = (await requireScopedPermission("manage_sessions", { session: sessionId })).staff.role;
  if (!sessionId) throw new Error("Session is required");

  await promoteFromWaitlist(sessionId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function generateScheduleAction(formData: FormData) {
  const sessionId = String(formData.get("session_id") ?? "");
  const role = (await requireScopedPermission("manage_sessions", { session: sessionId })).staff.role;
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
  const sessionId = String(formData.get("session_id") ?? "");
  const role = (await requireScopedPermission("manage_sessions", { session: sessionId })).staff.role;
  if (!sessionId) throw new Error("Session is required");

  await generateNextMexicanoRound(sessionId, role);
  // A published night: the new round's players hear their court and time.
  await afterNightRoundAdded(sessionId);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

/**
 * "Confirm players and publish table" (Phase 8): the ticked players play
 * tonight, the table is generated with its order of play per court and "about"
 * times, and the players are told. The organisation comes from the session.
 */
export async function publishNightTableAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const sessionId = String(formData.get("session_id") ?? "");
  if (!sessionId) throw new Error("Session is required");
  const { staff } = await requireScopedPermission("manage_sessions", { session: sessionId });
  const playing = formData.getAll("playing").map(String).filter(Boolean);
  await requireOwnPlayers(staff.orgId, playing);
  // "Confirm at least 4 players…", "The night has started…": answered next to the button (StateForm), not as an error page.
  return formResult(async () => {
    await publishNightTable(
      sessionId,
      {
        playing: formData.get("confirm_players") === "1" ? playing : null,
        matchMinutes: Number(formData.get("match_minutes") ?? "") || null,
        changeoverMinutes: formData.get("changeover_minutes") === null || formData.get("changeover_minutes") === "" ? null : Number(formData.get("changeover_minutes")),
      },
      { role: staff.role, userId: staff.userId ?? null },
    );
    revalidatePath(`/admin/friendly-sessions/${sessionId}`);
    return "Table published.";
  });
}

/**
 * A final result typed by the organiser on a session's page (Phase 2 on nights):
 * the same RESULT_ENTERED path as a referee's device, refused when the session
 * scores point by point only. The match must be one of this session's.
 */
export async function enterSessionResult(sessionId: string, matchId: string, payload: unknown): Promise<EnterResultOutcome> {
  const { staff } = await requireScopedPermission("score_match", { match: matchId });
  const session = await getSession(sessionId);
  const { data: m } = await db().from("matches").select("tournament_id, stage").eq("id", matchId).maybeSingle();
  const match = m as { tournament_id: string; stage: string } | null;
  if (!session || !match || match.tournament_id !== session.tournament_id || match.stage !== "friendly") return { ok: false, error: NOT_FOUND };
  const out = await enterFinalResult({
    matchId,
    payload,
    role: staff.role,
    actor: staff.userId ?? staff.codeId ?? staff.role,
    defer: (task) => after(task),
  });
  if (out.ok) revalidatePath(`/admin/friendly-sessions/${sessionId}`);
  return out;
}

export async function autoPairAction(formData: FormData) {
  const sessionId = String(formData.get("session_id") ?? "");
  const role = (await requireScopedPermission("manage_sessions", { session: sessionId })).staff.role;
  if (!sessionId) throw new Error("Session is required");

  await autoPair(sessionId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

/** Called from the drag-and-drop pairing board with typed args. */
export async function savePairsAction(sessionId: string, couples: [string, string][]) {
  if (!sessionId) throw new Error("Session is required");
  const { staff } = await requireScopedPermission("manage_sessions", { session: sessionId });
  const role = staff.role;
  await requireOwnPlayers(staff.orgId, couples.flat());

  await setFixedPairs(sessionId, couples, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

export async function finalizeSessionAction(formData: FormData) {
  const sessionId = String(formData.get("session_id") ?? "");
  const role = (await requireScopedPermission("manage_sessions", { session: sessionId })).staff.role;
  if (!sessionId) throw new Error("Session is required");

  await finalizeSession(sessionId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
  revalidatePath("/admin/rankings");
}

export async function reopenSessionAction(formData: FormData) {
  const sessionId = String(formData.get("session_id") ?? "");
  const role = (await requireScopedPermission("manage_sessions", { session: sessionId })).staff.role;
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
  if (!sessionId) throw new Error("Session is required");
  const { staff } = await requireScopedPermission("manage_sessions", { session: sessionId });
  const role = staff.role;
  await requireOwnPlayers(staff.orgId, profileIds);
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
  const sessionId = String(formData.get("session_id") ?? "");
  const profileId = String(formData.get("player_profile_id") ?? "");
  if (!sessionId || !profileId) throw new Error("Session and player are required");
  const { staff } = await requireScopedPermission("manage_sessions", { session: sessionId });
  const role = staff.role;
  await requireOwnPlayers(staff.orgId, [profileId]);

  await addEntryForProfile(sessionId, profileId, role);
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}

/**
 * How many places a session's closing ceremony reveals on the wall. Stored on
 * the backing tournament's format, where the ceremony reads a tournament's Cup
 * depth, so one ceremony serves both.
 */
export async function setSessionPodiumDepthAction(formData: FormData) {
  const sessionId = String(formData.get("session_id") ?? "");
  const role = (await requireScopedPermission("manage_sessions", { session: sessionId })).staff.role;
  const depth = Math.min(4, Math.max(1, parseInt(String(formData.get("podium_depth") ?? "3"), 10) || 3)) as 1 | 2 | 3 | 4;
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  const backing = await getTournament(session.tournament_id);
  if (!backing) throw new Error("Session has no backing tournament");
  const format = backing.format_config ?? {};
  await db()
    .from("tournaments")
    .update({ format_config: { ...format, tiers: { ...(format.tiers ?? {}), cup: { ...(format.tiers?.cup ?? {}), podiumDepth: depth } } } })
    .eq("id", backing.id);
  await audit({ tournament_id: backing.id, actor_role: role, action: "SESSION_PODIUM_DEPTH_SET", new_value: { depth } });
  revalidatePath(`/admin/friendly-sessions/${sessionId}`);
}
