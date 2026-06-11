"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { generateGroupMatches } from "@/lib/ops";

function path(id: string) {
  return `/admin/tournaments/${id}/matches`;
}

export async function regenerateMatches(formData: FormData) {
  const role = await requirePermission("generate_matches");
  const tournamentId = String(formData.get("tournament_id"));
  await generateGroupMatches(tournamentId, role);
  revalidatePath(path(tournamentId));
}

export async function updateMatchSchedule(formData: FormData) {
  const role = await requirePermission("generate_matches");
  const tournamentId = String(formData.get("tournament_id"));
  const matchId = String(formData.get("match_id"));
  const courtId = String(formData.get("court_id") ?? "");
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
    .eq("id", matchId);
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
  const { data: maxRow } = await db()
    .from("matches")
    .select("match_order")
    .eq("tournament_id", tournamentId)
    .order("match_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const groupId = String(formData.get("group_id") ?? "");
  await db().from("matches").insert({
    tournament_id: tournamentId,
    stage: groupId ? "group" : "knockout",
    group_id: groupId || null,
    round_name: String(formData.get("round_name") ?? "Manual match") || "Manual match",
    match_order: (maxRow?.match_order ?? 0) + 1,
    court_id: String(formData.get("court_id") ?? "") || null,
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

export async function deleteMatch(formData: FormData) {
  const role = await requirePermission("generate_matches");
  const tournamentId = String(formData.get("tournament_id"));
  const matchId = String(formData.get("match_id"));
  await db().from("matches").delete().eq("id", matchId);
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "MATCH_DELETED",
    entity_type: "match",
    entity_id: matchId,
  });
  revalidatePath(path(tournamentId));
}

/** Admin can release a stuck scoring-device lock. */
export async function releaseScoringLock(formData: FormData) {
  const role = await requirePermission("generate_matches");
  const tournamentId = String(formData.get("tournament_id"));
  const matchId = String(formData.get("match_id"));
  await db().from("matches").update({ active_scoring_device_id: null }).eq("id", matchId);
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "SCORING_LOCK_RELEASED",
    entity_type: "match",
    entity_id: matchId,
  });
  revalidatePath(path(tournamentId));
}
