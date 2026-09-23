"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit, slugify } from "@/lib/audit";
import { cloneTournament as cloneOp, deleteTournamentRow, resetTournamentLiveData, type CloneOptions } from "@/lib/ops";
import { refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { DEFAULT_CHESS_FORMAT, DEFAULT_SCORING_CONFIG, DEFAULT_TENNIS_SCORING_CONFIG, type FormatConfig } from "@/lib/types";
import { ensureMainScreen } from "@/lib/screens";

export async function createTournament(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Name is required");
  const requested = String(formData.get("sport") ?? "padel");
  const sport = requested === "chess" || requested === "tennis" ? requested : "padel";
  const courtCount = Math.min(20, Math.max(1, parseInt(String(formData.get("courts") ?? "2"), 10) || 2));
  const isDemo = formData.get("is_demo") === "on";

  const isChess = sport === "chess";
  const formatConfig: FormatConfig | undefined = isChess
    ? {
        ...DEFAULT_CHESS_FORMAT,
        legs: String(formData.get("legs") ?? "1") === "2" ? 2 : 1,
        thirdPlaceMatch: formData.get("third_place") === "on",
      }
    : undefined;

  const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
  const { data: tournament, error } = await db()
    .from("tournaments")
    .insert({
      name,
      slug,
      sport,
      is_demo: isDemo,
      // A new padel tournament confirms results by default: the match-winning
      // point shows the score and waits, so a mis-tap on match point is caught
      // before it reaches the standings and the bracket. Existing tournaments
      // are left as they were, so no referee finds the flow changed mid-event.
      scoring_config: {
        ...(sport === "tennis" ? DEFAULT_TENNIS_SCORING_CONFIG : DEFAULT_SCORING_CONFIG),
        requireResultConfirmation: !isChess,
      },
      ...(formatConfig ? { format_config: formatConfig } : {}),
      created_by: role,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  const label = isChess ? "Board" : "Court";
  const courts = Array.from({ length: courtCount }, (_, i) => ({
    tournament_id: tournament.id,
    court_name: `${label} ${i + 1}`,
    court_order: i + 1,
  }));
  await db().from("courts").insert(courts);
  await ensureMainScreen(tournament.id);
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
  // Cloning a session's hidden row would make a tournament out of a session.
  refuse(await tournamentRowRefusal(sourceId));
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
  // A session's status (open, scheduled, finalized…) is its own; its hidden row's
  // is kept in step by the session code.
  refuse(await tournamentRowRefusal(id));
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
  // Refuses a session's hidden row: the delete would cascade into the session.
  const result = await deleteTournamentRow(id, role);
  if (!result.ok) throw new Error(result.message);
  revalidatePath("/admin/tournaments");
}

/** Demo/training reset (spec §24): wipes live data, keeps setup. Tournaments only. */
export async function resetTournamentData(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("id"));
  const result = await resetTournamentLiveData(id, role);
  // The dashboard does not offer this for a friendly session's backing row; a
  // request that arrives anyway is refused before anything is deleted.
  if (!result.ok) throw new Error(result.message);
  revalidatePath(`/admin/tournaments/${id}`);
}
