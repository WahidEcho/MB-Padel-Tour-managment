"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { fillMissingCodes, resetPlayerCode } from "@/lib/players/claims";
import { toE164 } from "@/lib/players/phone";

const path = (id: string) => `/admin/tournaments/${id}/players`;

/** The player, if it belongs to this tournament: a form cannot reach another tournament's player. */
async function playerIn(tournamentId: string, playerId: string): Promise<{ id: string; full_name: string } | null> {
  const { data } = await db().from("players").select("id, full_name").eq("id", playerId).eq("tournament_id", tournamentId).maybeSingle();
  return (data as { id: string; full_name: string } | null) ?? null;
}

/** A new code; the old one stops working and the account it linked lets go. */
export async function resetCode(formData: FormData) {
  const role = await requirePermission("manage_players");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const player = await playerIn(id, String(formData.get("player_id")));
  if (!player) throw new Error("That player is not in this tournament.");
  await resetPlayerCode(player.id);
  await audit({ tournament_id: id, actor_role: role, action: "PLAYER_CODE_RESET", entity_type: "player", entity_id: player.id });
  revalidatePath(path(id));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The player's own phone and email, which the share links use. */
export async function savePlayerContact(formData: FormData) {
  const role = await requirePermission("manage_players");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const player = await playerIn(id, String(formData.get("player_id")));
  if (!player) throw new Error("That player is not in this tournament.");
  const rawPhone = String(formData.get("phone") ?? "").trim();
  const rawEmail = String(formData.get("email") ?? "").trim().toLowerCase();
  const phone = rawPhone ? toE164(rawPhone) : null;
  if (rawPhone && !phone) throw new Error(`${player.full_name}: "${rawPhone}" is not a phone number. Use 01… for Egypt or +country code.`);
  if (rawEmail && (!EMAIL.test(rawEmail) || rawEmail.length > 254)) throw new Error(`${player.full_name}: "${rawEmail}" is not an email address.`);
  const { error } = await db()
    .from("players")
    .update({ phone, email: rawEmail || null, updated_at: new Date().toISOString() })
    .eq("id", player.id);
  if (error) throw new Error(error.message);
  await audit({ tournament_id: id, actor_role: role, action: "PLAYER_CONTACT_UPDATED", entity_type: "player", entity_id: player.id, new_value: { phone: Boolean(phone), email: Boolean(rawEmail) } });
  revalidatePath(path(id));
}

/** Codes for any player without one. */
export async function fillCodes(formData: FormData) {
  const role = await requirePermission("manage_players");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const made = await fillMissingCodes(id);
  await audit({ tournament_id: id, actor_role: role, action: "PLAYER_CODES_FILLED", entity_type: "tournament", entity_id: id, new_value: { count: made } });
  revalidatePath(path(id));
}
