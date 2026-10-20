"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requireTournamentPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { DEFAULT_FOCAL } from "@/lib/portrait";
import { entityRefusal, refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { nationByCode, normalizeNationCode } from "@/lib/tennis/nations";
import { itfRanksOf, parseItfRank, withItfRanks } from "@/lib/players/publicInfo";
import type { FormatConfig } from "@/lib/types";

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

/** The ITF junior ranking typed for slot `n`, or undefined when the form has no such field. */
function rankField(formData: FormData, n: number): number | null | undefined {
  const key = `player_${n}_itf_rank`;
  if (!formData.has(key)) return undefined;
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  const rank = parseItfRank(raw);
  if (rank === null) throw new Error(`Player ${n}: the ITF junior ranking is a whole number from 1, e.g. 42.`);
  return rank;
}

/**
 * Writes players' ITF junior rankings into the tournament's format_config
 * (`itfJuniorRanks`), compare-and-set on updated_at so a tie or lots write
 * running at the same moment is never overwritten.
 */
async function saveRanks(tournamentId: string, updates: Record<string, number | null>) {
  if (!Object.keys(updates).length) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: row } = await db().from("tournaments").select("format_config, updated_at").eq("id", tournamentId).maybeSingle();
    if (!row) return;
    const current = row as { format_config: FormatConfig | null; updated_at: string | null };
    const before = itfRanksOf(current.format_config);
    const after = withItfRanks(before, updates);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    let query = db()
      .from("tournaments")
      .update({ format_config: { ...(current.format_config ?? {}), itfJuniorRanks: after }, updated_at: new Date().toISOString() })
      .eq("id", tournamentId);
    query = current.updated_at === null ? query.is("updated_at", null) : query.eq("updated_at", current.updated_at);
    const { data: written } = await query.select("id");
    if ((written ?? []).length === 1) return;
  }
  throw new Error("The tournament changed while saving the rankings. Save again.");
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
  const tournamentId = String(formData.get("tournament_id"));
  const role = (await requireTournamentPermission("manage_teams", tournamentId)).staff.role;
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
  const ranks = Object.fromEntries(players.map((p) => [p.player_order, rankField(formData, p.player_order)]));
  const { data: inserted } = await db().from("players").insert(players).select("id, player_order");
  const rankUpdates: Record<string, number | null> = {};
  for (const p of (inserted ?? []) as { id: string; player_order: number }[]) {
    const r = ranks[p.player_order];
    if (typeof r === "number") rankUpdates[p.id] = r;
  }
  await saveRanks(tournamentId, rankUpdates);
  await audit({ tournament_id: tournamentId, actor_role: role, action: "NATION_ADDED", entity_type: "team", entity_id: team.id, new_value: fields });
  revalidatePath(path(tournamentId));
}

export async function updateNation(formData: FormData) {
  const tournamentId = String(formData.get("tournament_id"));
  const role = (await requireTournamentPermission("manage_teams", tournamentId)).staff.role;
  const teamId = String(formData.get("team_id"));
  refuse(await entityRefusal(tournamentId, "teams", teamId));
  const fields = nationFields(formData);
  // Read every ranking first, so a bad one refuses the save before anything is written.
  const ranks = new Map<number, number | null | undefined>();
  for (let i = 1; i <= MAX_PLAYERS; i++) ranks.set(i, rankField(formData, i));
  await db().from("teams").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", teamId);
  const { data: existing } = await db().from("players").select("id, player_order").eq("team_id", teamId);
  const byOrder = new Map(((existing ?? []) as { id: string; player_order: number }[]).map((p) => [p.player_order, p.id]));
  const rankUpdates: Record<string, number | null> = {};
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    const name = String(formData.get(`player_${i}_name`) ?? "").trim();
    const photo = photoPatch(formData, `player_${i}`) ?? {};
    let id = byOrder.get(i);
    if (id && name) {
      await db().from("players").update({ full_name: name, ...photo, updated_at: new Date().toISOString() }).eq("id", id);
    } else if (!id && name) {
      const { data: added } = await db().from("players").insert({ tournament_id: tournamentId, team_id: teamId, player_order: i, full_name: name, ...photo }).select("id").maybeSingle();
      id = (added as { id: string } | null)?.id;
    }
    // A cleared name keeps the player: they may already be nominated in a tie.
    const rank = ranks.get(i);
    if (id && rank !== undefined) rankUpdates[id] = rank;
  }
  await saveRanks(tournamentId, rankUpdates);
  await audit({ tournament_id: tournamentId, actor_role: role, action: "NATION_UPDATED", entity_type: "team", entity_id: teamId, new_value: fields });
  revalidatePath(path(tournamentId));
}

export async function deleteNation(formData: FormData) {
  const tournamentId = String(formData.get("tournament_id"));
  const role = (await requireTournamentPermission("manage_teams", tournamentId)).staff.role;
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
