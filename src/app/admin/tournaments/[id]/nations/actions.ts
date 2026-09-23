"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { DEFAULT_FOCAL } from "@/lib/portrait";
import { entityRefusal, refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { nationByCode, normalizeNationCode } from "@/lib/tennis/nations";

const MAX_PLAYERS = 4;
const path = (id: string) => `/admin/tournaments/${id}/nations`;

function photoPatch(formData: FormData, prefix: string) {
  if (!formData.has(`${prefix}_photo_url`)) return null;
  const url = String(formData.get(`${prefix}_photo_url`) ?? "").trim();
  const focal = (axis: "x" | "y", fallback: number) => {
    const raw = Number(formData.get(`${prefix}_focal_${axis}`));
    return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : fallback;
  };
  return { photo_url: url || null, focal_x: focal("x", DEFAULT_FOCAL[0]), focal_y: focal("y", DEFAULT_FOCAL[1]) };
}

/** The nation fields from a form: a known ITF code fills the name and flag. */
function nationFields(formData: FormData) {
  const code = normalizeNationCode(String(formData.get("nation_code") ?? ""));
  if (!code) throw new Error("Enter the nation's three-letter ITF code, e.g. EGY.");
  const known = nationByCode(code);
  const name = String(formData.get("team_name") ?? "").trim() || known?.name;
  if (!name) throw new Error(`${code} is not a code this app knows; enter the nation's name too.`);
  const seed = parseInt(String(formData.get("seed_number") ?? ""), 10);
  return {
    team_name: name,
    nation_code: code,
    iso2: known?.iso2 ?? null,
    captain_name: String(formData.get("captain_name") ?? "").trim() || null,
    seed_number: Number.isFinite(seed) && seed > 0 ? seed : null,
  };
}

export async function addNation(formData: FormData) {
  const role = await requirePermission("manage_teams");
  const tournamentId = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(tournamentId));
  const fields = nationFields(formData);
  const { data: team, error } = await db()
    .from("teams")
    .insert({ tournament_id: tournamentId, ...fields, check_in_status: "checked_in" })
    .select()
    .single();
  if (error) throw new Error(error.message);
  const players = [];
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    const name = String(formData.get(`player_${i}_name`) ?? "").trim();
    if (!name) continue;
    players.push({ tournament_id: tournamentId, team_id: team.id, player_order: i, full_name: name, ...(photoPatch(formData, `player_${i}`) ?? {}) });
  }
  if (players.length < 2) {
    await db().from("teams").delete().eq("id", team.id);
    throw new Error("A nation needs at least two players to play a doubles.");
  }
  await db().from("players").insert(players);
  await audit({ tournament_id: tournamentId, actor_role: role, action: "NATION_ADDED", entity_type: "team", entity_id: team.id, new_value: fields });
  revalidatePath(path(tournamentId));
}

export async function updateNation(formData: FormData) {
  const role = await requirePermission("manage_teams");
  const tournamentId = String(formData.get("tournament_id"));
  const teamId = String(formData.get("team_id"));
  refuse(await entityRefusal(tournamentId, "teams", teamId));
  const fields = nationFields(formData);
  await db().from("teams").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", teamId);
  const { data: existing } = await db().from("players").select("id, player_order").eq("team_id", teamId);
  const byOrder = new Map(((existing ?? []) as { id: string; player_order: number }[]).map((p) => [p.player_order, p.id]));
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    const name = String(formData.get(`player_${i}_name`) ?? "").trim();
    const photo = photoPatch(formData, `player_${i}`) ?? {};
    const id = byOrder.get(i);
    if (id && name) {
      await db().from("players").update({ full_name: name, ...photo, updated_at: new Date().toISOString() }).eq("id", id);
    } else if (!id && name) {
      await db().from("players").insert({ tournament_id: tournamentId, team_id: teamId, player_order: i, full_name: name, ...photo });
    }
    // A cleared name keeps the player: they may already be nominated in a tie.
  }
  await audit({ tournament_id: tournamentId, actor_role: role, action: "NATION_UPDATED", entity_type: "team", entity_id: teamId, new_value: fields });
  revalidatePath(path(tournamentId));
}

export async function deleteNation(formData: FormData) {
  const role = await requirePermission("manage_teams");
  const tournamentId = String(formData.get("tournament_id"));
  const teamId = String(formData.get("team_id"));
  refuse(await entityRefusal(tournamentId, "teams", teamId));
  const { count } = await db()
    .from("ties")
    .select("id", { count: "exact", head: true })
    .eq("tournament_id", tournamentId)
    .or(`team_a_id.eq.${teamId},team_b_id.eq.${teamId}`);
  if ((count ?? 0) > 0) throw new Error("This nation is already drawn into ties. Remove it from the groups and regenerate the ties first.");
  await db().from("teams").delete().eq("id", teamId);
  await audit({ tournament_id: tournamentId, actor_role: role, action: "NATION_DELETED", entity_type: "team", entity_id: teamId });
  revalidatePath(path(tournamentId));
}
