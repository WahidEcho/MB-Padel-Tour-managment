"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { recalcStandings } from "@/lib/ops";
import { entityRefusal, refuse, tournamentRowRefusal } from "@/lib/rowGuards";

export async function recalcAction(formData: FormData) {
  await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  // A session ranks players, not group standings; writing group standings onto
  // its row would feed a knockout draw from the tournament tools.
  refuse(await tournamentRowRefusal(id));
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
  refuse(await entityRefusal(id, "standings_snapshots", standingId));
  const reset = formData.get("reset") === "1";
  const { data: old } = await db().from("standings_snapshots").select("*").eq("id", standingId).single();
  await db()
    .from("standings_snapshots")
    .update({ status: reset ? "pending" : status, manual_status_override: !reset })
    .eq("id", standingId)
    .eq("tournament_id", id);
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
