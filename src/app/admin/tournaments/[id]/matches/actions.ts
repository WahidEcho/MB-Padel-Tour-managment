"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { deleteManualMatch } from "@/lib/ops";
import { entityRefusal, ownershipRefusal, refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { runGroupStageRegeneration, type GroupStageFormState } from "../groupStage";

function path(id: string) {
  return `/admin/tournaments/${id}/matches`;
}

export async function regenerateMatches(_prev: GroupStageFormState, formData: FormData): Promise<GroupStageFormState> {
  const role = await requirePermission("generate_matches");
  const tournamentId = String(formData.get("tournament_id"));
  return runGroupStageRegeneration(tournamentId, role, formData);
}

export async function updateMatchSchedule(formData: FormData) {
  const role = await requirePermission("generate_matches");
  const tournamentId = String(formData.get("tournament_id"));
  const matchId = String(formData.get("match_id"));
  const courtId = String(formData.get("court_id") ?? "");
  // A session schedules its own rounds; and a match or court named here must be
  // this tournament's own.
  refuse(await entityRefusal(tournamentId, "matches", matchId));
  if (courtId) refuse(await ownershipRefusal(tournamentId, "courts", courtId));
  const order = parseInt(String(formData.get("match_order") ?? ""), 10);
  const time = String(formData.get("scheduled_time") ?? "");
  await db()
    .from("matches")
    .update({
      court_id: courtId || null,
      match_order: Number.isFinite(order) ? order : undefined,
      scheduled_time: time ? new Date(time).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", matchId)
    .eq("tournament_id", tournamentId);
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "MATCH_SCHEDULE_EDITED",
    entity_type: "match",
    entity_id: matchId,
  });
  revalidatePath(path(tournamentId));
}

export async function createManualMatch(formData: FormData) {
  const role = await requirePermission("generate_matches");
  const tournamentId = String(formData.get("tournament_id"));
  const teamA = String(formData.get("team_a_id"));
  const teamB = String(formData.get("team_b_id"));
  if (!teamA || !teamB || teamA === teamB) throw new Error("Pick two different teams");
  const groupId = String(formData.get("group_id") ?? "");
  const courtId = String(formData.get("court_id") ?? "");
  // A match added to a session's row would be stage 'group' or 'knockout', never
  // relabelled, and invisible to the session. Its teams, group and court must also
  // be this tournament's.
  refuse(await tournamentRowRefusal(tournamentId));
  refuse(await ownershipRefusal(tournamentId, "teams", [teamA, teamB]));
  if (groupId) refuse(await ownershipRefusal(tournamentId, "groups", groupId));
  if (courtId) refuse(await ownershipRefusal(tournamentId, "courts", courtId));
  const { data: maxRow } = await db()
    .from("matches")
    .select("match_order")
    .eq("tournament_id", tournamentId)
    .order("match_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  await db().from("matches").insert({
    tournament_id: tournamentId,
    stage: groupId ? "group" : "knockout",
    group_id: groupId || null,
    round_name: String(formData.get("round_name") ?? "Manual match") || "Manual match",
    match_order: (maxRow?.match_order ?? 0) + 1,
    court_id: courtId || null,
    team_a_id: teamA,
    team_b_id: teamB,
    status: "scheduled",
  });
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "MATCH_CREATED_MANUALLY",
    entity_type: "match",
  });
  revalidatePath(path(tournamentId));
}

/**
 * Deletes a manually created match. Refuses a session's row, another tournament's
 * match, and a bracket match — see deleteManualMatch.
 */
export async function deleteMatch(formData: FormData) {
  const role = await requirePermission("generate_matches");
  const tournamentId = String(formData.get("tournament_id"));
  const matchId = String(formData.get("match_id"));
  const result = await deleteManualMatch(tournamentId, matchId, role);
  if (!result.ok) throw new Error(result.message);
  revalidatePath(path(tournamentId));
}

/**
 * Admin can release a stuck scoring-device lock. Shared with sessions — a stuck
 * tablet is the same problem there — but still only for this tournament's match.
 */
export async function releaseScoringLock(formData: FormData) {
  const role = await requirePermission("generate_matches");
  const tournamentId = String(formData.get("tournament_id"));
  const matchId = String(formData.get("match_id"));
  refuse(await ownershipRefusal(tournamentId, "matches", matchId));
  await db().from("matches").update({ active_scoring_device_id: null }).eq("id", matchId).eq("tournament_id", tournamentId);
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "SCORING_LOCK_RELEASED",
    entity_type: "match",
    entity_id: matchId,
  });
  revalidatePath(path(tournamentId));
}
