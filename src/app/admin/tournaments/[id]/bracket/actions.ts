"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { generateBracket, generateKnockoutFromTeams, publishBracket } from "@/lib/ops";
import { getBracket, getBracketSlots, getTournament } from "@/lib/data";

function path(id: string) {
  return `/admin/tournaments/${id}/bracket`;
}

export async function generateAction(formData: FormData) {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const tournament = await getTournament(id);
  if (tournament?.sport === "chess") {
    await generateKnockoutFromTeams(id, role);
  } else {
    await generateBracket(id, role);
  }
  revalidatePath(path(id));
}

/** Edit who-faces-who before publishing: reassign first-round slot teams. */
export async function saveSlots(formData: FormData) {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const bracket = await getBracket(id);
  if (!bracket || bracket.status === "published") throw new Error("Bracket not editable");

  const slots = await getBracketSlots(bracket.id);
  const updates: { slotId: string; teamId: string | null; isBye: boolean }[] = [];
  const seen = new Set<string>();
  for (const slot of slots) {
    const raw = formData.get(`slot_${slot.id}`);
    if (raw === null) continue;
    const value = String(raw);
    if (value === "__bye__") {
      updates.push({ slotId: slot.id, teamId: null, isBye: true });
    } else if (value === "") {
      updates.push({ slotId: slot.id, teamId: null, isBye: false });
    } else {
      if (seen.has(value)) throw new Error("A team is placed in two slots");
      seen.add(value);
      updates.push({ slotId: slot.id, teamId: value, isBye: false });
    }
  }
  for (const u of updates) {
    await db()
      .from("bracket_slots")
      .update({ team_id: u.teamId, is_bye: u.isBye, source_type: "manual" })
      .eq("id", u.slotId);
  }
  await audit({ tournament_id: id, actor_role: role, action: "BRACKET_EDITED", entity_type: "bracket", entity_id: bracket.id });
  revalidatePath(path(id));
}

export async function approveAction(formData: FormData) {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const bracket = await getBracket(id);
  if (!bracket) throw new Error("No bracket");
  await db()
    .from("brackets")
    .update({ status: "approved", approved_by: role, approved_at: new Date().toISOString() })
    .eq("id", bracket.id);
  await audit({ tournament_id: id, actor_role: role, action: "BRACKET_APPROVED", entity_type: "bracket", entity_id: bracket.id });
  revalidatePath(path(id));
}

export async function publishAction(formData: FormData) {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  await publishBracket(id, role);
  revalidatePath(path(id));
  revalidatePath(`/admin/tournaments/${id}/matches`);
}

export async function resetBracket(formData: FormData) {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  await db().from("matches").delete().eq("tournament_id", id).neq("stage", "group");
  await db().from("brackets").delete().eq("tournament_id", id);
  await audit({ tournament_id: id, actor_role: role, action: "BRACKET_RESET" });
  revalidatePath(path(id));
}
