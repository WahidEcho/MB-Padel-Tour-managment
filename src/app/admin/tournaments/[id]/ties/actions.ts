"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { delayOrderOfPlay, drawPlacement, generateGroupTies, lockLineups, resetPlacement, scheduleTie, setLineup } from "@/lib/tennis/tieOps";
import { zonedToIso } from "@/lib/tennis/ties";

const path = (id: string) => `/admin/tournaments/${id}/ties`;

export type TieFormState = { ok: boolean; message: string } | null;

export async function generateTiesAction(formData: FormData) {
  const role = await requirePermission("manage_groups");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  await generateGroupTies(id, role);
  revalidatePath(path(id));
}

export async function saveLineupAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const role = await requirePermission("manage_teams");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const tieId = String(formData.get("tie_id"));
  const side = String(formData.get("side")) === "B" ? "B" : "A";
  const v = (k: string) => String(formData.get(k) ?? "") || null;
  const result = await setLineup(
    tieId,
    side,
    { S1: v("S1"), S2: v("S2"), D: [v("D1"), v("D2")] },
    role,
    { lateChangeReason: String(formData.get("reason") ?? "").trim() || undefined },
  );
  revalidatePath(path(id));
  return result.ok ? { ok: true, message: "Line-up saved." } : { ok: false, message: result.message };
}

export async function lockLineupsAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const role = await requirePermission("manage_teams");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const result = await lockLineups(String(formData.get("tie_id")), role);
  revalidatePath(path(id));
  return result.ok ? { ok: true, message: "Line-ups locked." } : { ok: false, message: result.message };
}

export async function drawPlacementAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const role = await requirePermission("manage_groups");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const result = await drawPlacement(id, role);
  revalidatePath(path(id));
  return result.ok ? { ok: true, message: `Placement draws made: ${result.ties} ties.` } : { ok: false, message: result.message };
}

export async function resetPlacementAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const role = await requirePermission("manage_groups");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const result = await resetPlacement(id, role);
  revalidatePath(path(id));
  return result.ok ? { ok: true, message: "Placement draws removed." } : { ok: false, message: result.message };
}

export async function delayOrderOfPlayAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const role = await requirePermission("manage_groups");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const minutes = Number(formData.get("minutes"));
  const courtId = String(formData.get("court_id") ?? "") || null;
  const result = await delayOrderOfPlay(id, minutes, courtId, role);
  revalidatePath(path(id));
  if (!result.ok) return { ok: false, message: result.message };
  const moved = `${result.ties} tie${result.ties === 1 ? "" : "s"} and ${result.rubbers} rubber${result.rubbers === 1 ? "" : "s"}`;
  return { ok: true, message: `${moved} moved ${minutes > 0 ? "back" : "forward"} ${Math.abs(minutes)} minutes.` };
}

export async function scheduleTieAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const role = await requirePermission("manage_groups");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const local = String(formData.get("scheduled_local") ?? "").trim();
  const at = local ? zonedToIso(local) : null;
  if (local && !at) return { ok: false, message: "That time could not be read." };
  const result = await scheduleTie(String(formData.get("tie_id")), String(formData.get("court_id") ?? "") || null, at, role);
  revalidatePath(path(id));
  return result.ok ? { ok: true, message: "Court and time saved." } : { ok: false, message: result.message };
}
