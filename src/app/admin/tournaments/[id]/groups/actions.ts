"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { generateDraw, generateDrawOptions, groupName, type DrawOption } from "@/lib/draws";
import { getGroups, getGroupTeams, getTeams } from "@/lib/data";
import { groupDrawLock } from "@/lib/ops";
import { runGroupStageRegeneration, type GroupStageFormState } from "../groupStage";

function path(id: string) {
  return `/admin/tournaments/${id}/groups`;
}

/** Creates N groups and randomly distributes all active teams. */
export async function createGroups(formData: FormData) {
  const role = await requirePermission("manage_groups");
  const tournamentId = String(formData.get("tournament_id"));
  const count = Math.max(1, Math.min(26, parseInt(String(formData.get("group_count") ?? "2"), 10) || 2));

  // Recreating groups deletes their standings through the database's cascade, so
  // a drawn knockout would be left seeded from standings that no longer exist.
  // The page hides this form while a bracket exists; this is the backstop.
  const lock = await groupDrawLock(tournamentId);
  if (lock) throw new Error(lock);

  const teams = await getTeams(tournamentId);
  if (teams.length < count) throw new Error("More groups than teams");

  await db().from("groups").delete().eq("tournament_id", tournamentId);
  const groupRows = Array.from({ length: count }, (_, i) => ({
    tournament_id: tournamentId,
    group_name: groupName(i),
    group_order: i + 1,
  }));
  const { data: groups, error } = await db().from("groups").insert(groupRows).select();
  if (error) throw new Error(error.message);

  const draw = generateDraw(teams.map((t) => t.id), count);
  const gtRows = draw.groups.flatMap((teamIds, gi) =>
    teamIds.map((teamId, pos) => ({
      tournament_id: tournamentId,
      group_id: groups![gi].id,
      team_id: teamId,
      position: pos + 1,
    }))
  );
  await db().from("group_teams").insert(gtRows);
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "GROUPS_CREATED",
    new_value: { count },
  });
  revalidatePath(path(tournamentId));
}

/** Returns multiple draw options without saving (spec §10). */
export async function drawOptions(tournamentId: string, optionCount: number): Promise<DrawOption[]> {
  await requirePermission("manage_groups");
  const [teams, groups, groupTeams] = await Promise.all([
    getTeams(tournamentId),
    getGroups(tournamentId),
    getGroupTeams(tournamentId),
  ]);
  if (groups.length === 0) throw new Error("Create groups first");
  const groupIndex = new Map(groups.map((g, i) => [g.id, i]));
  const locked: Record<string, number> = {};
  for (const gt of groupTeams) {
    if (gt.is_locked) locked[gt.team_id] = groupIndex.get(gt.group_id)!;
  }
  return generateDrawOptions(teams.map((t) => t.id), groups.length, locked, optionCount);
}

/** Saves a full assignment: groups[i] = ordered team ids. Keeps lock flags. */
export async function saveAssignment(
  tournamentId: string,
  assignment: string[][],
): Promise<{ ok: true } | { ok: false; message: string }> {
  const role = await requirePermission("manage_groups");
  // Moving a team between groups rewrites the standings a drawn knockout was
  // seeded from, the next time they are recalculated.
  const lock = await groupDrawLock(tournamentId);
  if (lock) return { ok: false, message: lock };
  const [groups, existing] = await Promise.all([getGroups(tournamentId), getGroupTeams(tournamentId)]);
  if (assignment.length !== groups.length) throw new Error("Assignment shape mismatch");
  const lockedTeams = new Set(existing.filter((gt) => gt.is_locked).map((gt) => gt.team_id));

  await db().from("group_teams").delete().eq("tournament_id", tournamentId);
  const rows = assignment.flatMap((teamIds, gi) =>
    teamIds.map((teamId, pos) => ({
      tournament_id: tournamentId,
      group_id: groups[gi].id,
      team_id: teamId,
      position: pos + 1,
      is_locked: lockedTeams.has(teamId),
    }))
  );
  if (rows.length > 0) {
    const { error } = await db().from("group_teams").insert(rows);
    if (error) throw new Error(error.message);
  }
  await audit({ tournament_id: tournamentId, actor_role: role, action: "GROUP_DRAW_SAVED" });
  revalidatePath(path(tournamentId));
  return { ok: true };
}

export async function toggleLock(formData: FormData) {
  await requirePermission("manage_groups");
  const tournamentId = String(formData.get("tournament_id"));
  const groupTeamId = String(formData.get("group_team_id"));
  const { data: gt } = await db().from("group_teams").select("is_locked").eq("id", groupTeamId).single();
  if (gt) {
    await db().from("group_teams").update({ is_locked: !gt.is_locked }).eq("id", groupTeamId);
  }
  revalidatePath(path(tournamentId));
}

export async function publishGroups(_prev: GroupStageFormState, formData: FormData): Promise<GroupStageFormState> {
  const role = await requirePermission("manage_groups");
  const tournamentId = String(formData.get("tournament_id"));
  // Groups are marked published only once the guard has let regeneration through,
  // so a refusal leaves the draw exactly as it was.
  const state = await runGroupStageRegeneration(tournamentId, role, formData, { publishGroups: true });
  if (state?.ok) {
    await audit({
      tournament_id: tournamentId,
      actor_role: role,
      action: "GROUPS_PUBLISHED",
      new_value: { message: state.message },
    });
  }
  return state;
}
