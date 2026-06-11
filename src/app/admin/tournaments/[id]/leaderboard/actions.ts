"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { recalcStandings } from "@/lib/ops";

export async function recalcAction(formData: FormData) {
  await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  await recalcStandings(id);
  revalidatePath(`/admin/tournaments/${id}/leaderboard`);
}

/** Manual qualification override (spec §15.6) — must be logged. */
export async function overrideQualification(formData: FormData) {
  const role = await requirePermission("score_match"); // admin/manager/referee
  const id = String(formData.get("tournament_id"));
  const standingId = String(formData.get("standing_id"));
  const status = String(formData.get("status"));
  if (!["pending", "qualified", "eliminated", "disqualified"].includes(status)) {
    throw new Error("Bad status");
  }
  const reset = formData.get("reset") === "1";
  const { data: old } = await db().from("standings_snapshots").select("*").eq("id", standingId).single();
  await db()
    .from("standings_snapshots")
    .update({ status: reset ? "pending" : status, manual_status_override: !reset })
    .eq("id", standingId);
  await audit({
    tournament_id: id,
    actor_role: role,
    action: reset ? "QUALIFICATION_OVERRIDE_CLEARED" : "QUALIFICATION_OVERRIDDEN",
    entity_type: "standing",
    entity_id: standingId,
    old_value: { status: old?.status },
    new_value: { status: reset ? "pending" : status },
  });
  if (reset) await recalcStandings(id);
  revalidatePath(`/admin/tournaments/${id}/leaderboard`);
}
