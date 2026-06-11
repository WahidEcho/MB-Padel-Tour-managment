"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit, slugify } from "@/lib/audit";
import { cloneTournament as cloneOp, type CloneOptions } from "@/lib/ops";
import { DEFAULT_SCORING_CONFIG } from "@/lib/types";

export async function createTournament(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Name is required");
  const courtCount = Math.min(20, Math.max(1, parseInt(String(formData.get("courts") ?? "2"), 10) || 2));
  const isDemo = formData.get("is_demo") === "on";

  const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
  const { data: tournament, error } = await db()
    .from("tournaments")
    .insert({
      name,
      slug,
      is_demo: isDemo,
      scoring_config: DEFAULT_SCORING_CONFIG,
      created_by: role,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  const courts = Array.from({ length: courtCount }, (_, i) => ({
    tournament_id: tournament.id,
    court_name: `Court ${i + 1}`,
    court_order: i + 1,
  }));
  await db().from("courts").insert(courts);
  await db().from("screen_settings").insert({ tournament_id: tournament.id, screen_key: "main" });
  await audit({
    tournament_id: tournament.id,
    actor_role: role,
    action: "TOURNAMENT_CREATED",
    entity_type: "tournament",
    entity_id: tournament.id,
    new_value: { name },
  });
  redirect(`/admin/tournaments/${tournament.id}`);
}

export async function cloneTournamentAction(formData: FormData) {
  const role = await requirePermission("clone_tournament");
  const sourceId = String(formData.get("source_id"));
  const opts: CloneOptions = {
    newName: String(formData.get("name") ?? "").trim() || "Cloned Tournament",
    copyTeams: formData.get("copy_teams") === "on",
    copyPhotos: formData.get("copy_photos") === "on",
    copyGroups: formData.get("copy_groups") === "on",
    copySchedule: formData.get("copy_schedule") === "on",
    copyBranding: formData.get("copy_branding") === "on",
    copyScoring: formData.get("copy_scoring") === "on",
    copyCourts: formData.get("copy_courts") === "on",
  };
  const created = await cloneOp(sourceId, opts, role);
  redirect(`/admin/tournaments/${created.id}`);
}

export async function setTournamentStatus(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("id"));
  const status = String(formData.get("status"));
  if (!["draft", "active", "completed", "archived"].includes(status)) throw new Error("Bad status");
  await db().from("tournaments").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
  await audit({
    tournament_id: id,
    actor_role: role,
    action: "TOURNAMENT_STATUS_CHANGED",
    entity_type: "tournament",
    entity_id: id,
    new_value: { status },
  });
  revalidatePath(`/admin/tournaments/${id}`);
  revalidatePath("/admin/tournaments");
}

export async function deleteTournament(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("id"));
  const { data: t } = await db().from("tournaments").select("name, is_demo").eq("id", id).single();
  await db().from("tournaments").delete().eq("id", id);
  await audit({
    actor_role: role,
    action: "TOURNAMENT_DELETED",
    entity_type: "tournament",
    entity_id: id,
    old_value: t,
  });
  revalidatePath("/admin/tournaments");
}

/** Demo/training reset (spec §24): wipes live data, keeps setup. */
export async function resetTournamentData(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("id"));
  await db().from("matches").delete().eq("tournament_id", id).neq("stage", "group");
  await db()
    .from("matches")
    .update({
      status: "scheduled",
      winner_team_id: null,
      serving_team_id: null,
      active_scoring_device_id: null,
      is_pending_sync: false,
      started_at: null,
      ended_at: null,
    })
    .eq("tournament_id", id);
  await db().from("match_score_snapshots").delete().eq("tournament_id", id);
  await db().from("score_events").delete().eq("tournament_id", id);
  await db().from("standings_snapshots").delete().eq("tournament_id", id);
  await db().from("brackets").delete().eq("tournament_id", id);
  await db().from("teams").update({ check_in_status: "not_arrived", team_status: "active" }).eq("tournament_id", id);
  await audit({
    tournament_id: id,
    actor_role: role,
    action: "TOURNAMENT_DATA_RESET",
    entity_type: "tournament",
    entity_id: id,
  });
  revalidatePath(`/admin/tournaments/${id}`);
}
