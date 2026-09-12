"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { deleteBracketCascade, generateBracket, generateKnockoutFromTeams, publishBracket } from "@/lib/ops";
import { getBracket, getBrackets, getBracketSlots, getTournament } from "@/lib/data";
import type { BracketTier } from "@/lib/types";
import type { CourtStrategy } from "@/lib/bracket";

/** Which tier a form is acting on. Defaults to the Cup, the only tier most
 *  tournaments have. */
function tierFrom(formData: FormData): BracketTier {
  return String(formData.get("tier") ?? "cup") === "plate" ? "plate" : "cup";
}

function path(id: string) {
  return `/admin/tournaments/${id}/bracket`;
}

export async function generateAction(formData: FormData) {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const tournament = await getTournament(id);
  if (tournament?.sport === "chess") {
    // Chess has no group stage, so no Plate to draw from.
    await generateKnockoutFromTeams(id, role);
  } else {
    await generateBracket(id, role, tierFrom(formData));
  }
  revalidatePath(path(id));
}

/** Edit who-faces-who before publishing: reassign first-round slot teams. */
export async function saveSlots(formData: FormData) {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const bracket = await getBracket(id, tierFrom(formData));
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
  const bracket = await getBracket(id, tierFrom(formData));
  if (!bracket) throw new Error("No bracket");
  await db()
    .from("brackets")
    .update({ status: "approved", approved_by: role, approved_at: new Date().toISOString() })
    .eq("id", bracket.id);
  await audit({ tournament_id: id, actor_role: role, action: "BRACKET_APPROVED", entity_type: "bracket", entity_id: bracket.id });
  revalidatePath(path(id));
}

/**
 * Publishes every drawn tier at once.
 *
 * Not per tier, because the court strategy cannot be honoured one bracket at a
 * time: whichever went first would already hold every court and every low order
 * number, so "both at once" would quietly become "one after another".
 */
export async function publishAction(formData: FormData) {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const strategy = (String(formData.get("court_strategy") ?? "parallel") === "sequential"
    ? "sequential"
    : "parallel") as CourtStrategy;
  await publishBracket(id, role, { courtStrategy: strategy });
  revalidatePath(path(id));
  revalidatePath(`/admin/tournaments/${id}/matches`);
}

/**
 * Deletes one tier and only its matches.
 *
 * It used to delete every match in the tournament that was not a group match,
 * which with two brackets would take the other tier's live draw with it.
 */
export async function resetBracket(formData: FormData) {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const tier = tierFrom(formData);
  const bracket = await getBracket(id, tier);
  if (!bracket) return;
  const { matchesDeleted } = await deleteBracketCascade(bracket.id);
  await audit({
    tournament_id: id,
    actor_role: role,
    action: "BRACKET_RESET",
    entity_type: "bracket",
    entity_id: bracket.id,
    old_value: { tier, matchesDeleted },
  });
  revalidatePath(path(id));
  revalidatePath(`/admin/tournaments/${id}/matches`);
}

/** Every tier a tournament has drawn, for the page to render one section each. */
export async function listBrackets(tournamentId: string) {
  await requirePermission("edit_bracket");
  return getBrackets(tournamentId);
}
