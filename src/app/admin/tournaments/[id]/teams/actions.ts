"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { recalcStandings } from "@/lib/ops";
import { getTournament } from "@/lib/data";
import { DEFAULT_FOCAL } from "@/lib/portrait";

function teamsPath(tournamentId: string) {
  return `/admin/tournaments/${tournamentId}/teams`;
}

/**
 * Reads a PlayerPhotoField's hidden inputs.
 *
 * The field uploads on pick and puts the resulting URL here, so the action never
 * handles bytes. An empty URL is an explicit "remove the photo" — something the
 * old file input could not express at all.
 */
function photoPatch(formData: FormData, prefix: string) {
  if (!formData.has(`${prefix}_photo_url`)) return null;
  const url = String(formData.get(`${prefix}_photo_url`) ?? "").trim();
  const focal = (axis: "x" | "y", fallback: number) => {
    const raw = Number(formData.get(`${prefix}_focal_${axis}`));
    return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : fallback;
  };
  return {
    photo_url: url || null,
    focal_x: focal("x", DEFAULT_FOCAL[0]),
    focal_y: focal("y", DEFAULT_FOCAL[1]),
  };
}

export async function addTeam(formData: FormData) {
  const role = await requirePermission("manage_teams");
  const tournamentId = String(formData.get("tournament_id"));
  const tournament = await getTournament(tournamentId);
  const isChess = tournament?.sport === "chess";

  // Chess = a single player; the player's name is stored as team_name.
  if (isChess) {
    const playerName = String(formData.get("team_name") ?? "").trim();
    if (!playerName) throw new Error("Player name is required");
    const { data: team, error } = await db()
      .from("teams")
      .insert({
        tournament_id: tournamentId,
        team_name: playerName,
        phone: String(formData.get("phone") ?? "").trim() || null,
        notes: String(formData.get("notes") ?? "").trim() || null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    await db().from("players").insert([
      {
        tournament_id: tournamentId,
        team_id: team.id,
        player_order: 1,
        full_name: playerName,
        ...(photoPatch(formData, "player_1") ?? {}),
      },
    ]);
    await audit({
      tournament_id: tournamentId,
      actor_role: role,
      action: "TEAM_ADDED",
      entity_type: "team",
      entity_id: team.id,
      new_value: { player_name: playerName },
    });
    revalidatePath(teamsPath(tournamentId));
    return;
  }

  const teamName = String(formData.get("team_name") ?? "").trim();
  const p1 = String(formData.get("player_1_name") ?? "").trim();
  const p2 = String(formData.get("player_2_name") ?? "").trim();
  if (!teamName || !p1 || !p2) throw new Error("Team name and both player names are required");

  const { data: team, error } = await db()
    .from("teams")
    .insert({
      tournament_id: tournamentId,
      team_name: teamName,
      phone: String(formData.get("phone") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  const players = [];
  for (const [order, name] of [
    [1, p1],
    [2, p2],
  ] as const) {
    players.push({
      tournament_id: tournamentId,
      team_id: team.id,
      player_order: order,
      full_name: name,
      ...(photoPatch(formData, `player_${order}`) ?? {}),
    });
  }
  await db().from("players").insert(players);
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "TEAM_ADDED",
    entity_type: "team",
    entity_id: team.id,
    new_value: { team_name: teamName },
  });
  revalidatePath(teamsPath(tournamentId));
}

export async function updateTeam(formData: FormData) {
  const role = await requirePermission("manage_teams");
  const tournamentId = String(formData.get("tournament_id"));
  const teamId = String(formData.get("team_id"));
  const tournament = await getTournament(tournamentId);
  const isChess = tournament?.sport === "chess";

  const newName = String(formData.get("team_name") ?? "").trim();
  await db()
    .from("teams")
    .update({
      team_name: newName,
      phone: String(formData.get("phone") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", teamId);

  // Chess: single player whose name mirrors team_name.
  if (isChess) {
    if (newName) {
      await db()
        .from("players")
        .update({ full_name: newName, updated_at: new Date().toISOString() })
        .eq("team_id", teamId)
        .eq("player_order", 1);
    }
    const photo = photoPatch(formData, "player_1");
    if (photo) {
      await db()
        .from("players")
        .update({ ...photo, updated_at: new Date().toISOString() })
        .eq("team_id", teamId)
        .eq("player_order", 1);
    }
    await audit({
      tournament_id: tournamentId,
      actor_role: role,
      action: "TEAM_UPDATED",
      entity_type: "team",
      entity_id: teamId,
    });
    revalidatePath(teamsPath(tournamentId));
    return;
  }

  for (const order of [1, 2]) {
    const name = String(formData.get(`player_${order}_name`) ?? "").trim();
    if (name) {
      await db()
        .from("players")
        .update({ full_name: name, updated_at: new Date().toISOString() })
        .eq("team_id", teamId)
        .eq("player_order", order);
    }
    const photo = photoPatch(formData, `player_${order}`);
    if (photo) {
      await db()
        .from("players")
        .update({ ...photo, updated_at: new Date().toISOString() })
        .eq("team_id", teamId)
        .eq("player_order", order);
    }
  }
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "TEAM_UPDATED",
    entity_type: "team",
    entity_id: teamId,
  });
  revalidatePath(teamsPath(tournamentId));
}

export async function deleteTeam(formData: FormData) {
  const role = await requirePermission("manage_teams");
  const tournamentId = String(formData.get("tournament_id"));
  const teamId = String(formData.get("team_id"));
  const { data: team } = await db().from("teams").select("team_name").eq("id", teamId).single();
  await db().from("teams").delete().eq("id", teamId);
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "TEAM_DELETED",
    entity_type: "team",
    entity_id: teamId,
    old_value: team,
  });
  revalidatePath(teamsPath(tournamentId));
}

export async function setCheckIn(formData: FormData) {
  const role = await requirePermission("check_in");
  const tournamentId = String(formData.get("tournament_id"));
  const teamId = String(formData.get("team_id"));
  const status = String(formData.get("status"));
  if (!["not_arrived", "checked_in", "no_show", "disqualified"].includes(status)) {
    throw new Error("Bad status");
  }
  const { data: team } = await db().from("teams").select("check_in_status").eq("id", teamId).single();
  await db()
    .from("teams")
    .update({ check_in_status: status, updated_at: new Date().toISOString() })
    .eq("id", teamId);
  await db().from("check_in_logs").insert({
    tournament_id: tournamentId,
    team_id: teamId,
    old_status: team?.check_in_status,
    new_status: status,
    actor_role: role,
  });
  revalidatePath(teamsPath(tournamentId));
  revalidatePath(`/referee/tournaments/${tournamentId}/matches`);
}

export async function setTeamStatus(formData: FormData) {
  const role = await requirePermission("score_match"); // admin/manager/referee can DQ + restore
  const tournamentId = String(formData.get("tournament_id"));
  const teamId = String(formData.get("team_id"));
  const status = String(formData.get("status"));
  if (!["active", "disqualified", "withdrawn"].includes(status)) throw new Error("Bad status");
  await db()
    .from("teams")
    .update({
      team_status: status,
      check_in_status: status === "disqualified" ? "disqualified" : "not_arrived",
      updated_at: new Date().toISOString(),
    })
    .eq("id", teamId);
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: status === "disqualified" ? "TEAM_DISQUALIFIED" : "TEAM_RESTORED",
    entity_type: "team",
    entity_id: teamId,
  });
  await recalcStandings(tournamentId);
  revalidatePath(teamsPath(tournamentId));
}

export interface ImportRow {
  team_name: string;
  player_1_name: string;
  player_2_name: string;
  player_1_photo_url: string;
  player_2_photo_url: string;
  phone: string;
  notes: string;
}

export async function importTeams(tournamentId: string, rows: ImportRow[]) {
  const role = await requirePermission("manage_teams");
  let imported = 0;
  for (const row of rows) {
    if (!row.team_name || !row.player_1_name || !row.player_2_name) continue;
    const { data: team, error } = await db()
      .from("teams")
      .insert({
        tournament_id: tournamentId,
        team_name: row.team_name,
        phone: row.phone || null,
        notes: row.notes || null,
      })
      .select()
      .single();
    if (error || !team) continue;
    await db().from("players").insert([
      {
        tournament_id: tournamentId,
        team_id: team.id,
        player_order: 1,
        full_name: row.player_1_name,
        photo_url: row.player_1_photo_url || null,
      },
      {
        tournament_id: tournamentId,
        team_id: team.id,
        player_order: 2,
        full_name: row.player_2_name,
        photo_url: row.player_2_photo_url || null,
      },
    ]);
    imported++;
  }
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "TEAMS_IMPORTED",
    entity_type: "tournament",
    entity_id: tournamentId,
    new_value: { imported },
  });
  revalidatePath(teamsPath(tournamentId));
  return imported;
}
