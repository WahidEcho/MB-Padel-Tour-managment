"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { recalcStandings } from "@/lib/ops";
import { isManualStatus } from "@/lib/standings";
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

export type OverrideState = { ok: boolean; message: string } | null;

/**
 * Manual qualification override (spec §15.6) — must be logged.
 *
 * Addressed by **team and group, not by the standings row's own id**. A standings
 * row is rebuilt from scratch on every recalculation — which happens whenever a
 * match finishes — so its id changes under the page while the organiser is
 * looking at it. Overriding by id worked once and then refused with "that
 * standing no longer exists" for every later change, including undoing the one
 * just made. A team's place in a group outlives the row that describes it.
 */
export async function overrideQualification(_prev: OverrideState, formData: FormData): Promise<OverrideState> {
  const role = await requirePermission("score_match"); // admin/manager/referee
  const id = String(formData.get("tournament_id"));
  const teamId = String(formData.get("team_id"));
  const groupId = String(formData.get("group_id"));
  const status = String(formData.get("status"));
  const reset = formData.get("reset") === "1";
  if (!reset && !isManualStatus(status)) {
    return { ok: false, message: "That is not a status this leaderboard uses." };
  }

  const refusal =
    (await entityRefusal(id, "teams", teamId)) ?? (await entityRefusal(id, "groups", groupId));
  if (refusal) return { ok: false, message: refusal };

  const { data: old } = await db()
    .from("standings_snapshots")
    .select("status")
    .eq("tournament_id", id)
    .eq("group_id", groupId)
    .eq("team_id", teamId)
    .maybeSingle();

  const { data: written, error } = await db()
    .from("standings_snapshots")
    .update({ status: reset ? "pending" : status, manual_status_override: !reset })
    .eq("tournament_id", id)
    .eq("group_id", groupId)
    .eq("team_id", teamId)
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!written || written.length === 0) {
    return { ok: false, message: "That team has no standings row yet. Press Recalculate now and try again." };
  }

  await audit({
    tournament_id: id,
    actor_role: role,
    action: reset ? "QUALIFICATION_OVERRIDE_CLEARED" : "QUALIFICATION_OVERRIDDEN",
    entity_type: "standing",
    entity_id: teamId,
    old_value: { status: (old as { status?: string } | null)?.status },
    new_value: { status: reset ? "pending" : status },
  });
  // Clearing an override hands the place back to the calculation. Setting one
  // recalculates too, so a team moved into or out of a qualifying place is
  // reflected everywhere at once rather than at the next finished match.
  await recalcStandings(id);
  revalidatePath(`/admin/tournaments/${id}/leaderboard`);
  return {
    ok: true,
    message: reset ? "Override cleared." : `Set to ${status}.`,
  };
}
