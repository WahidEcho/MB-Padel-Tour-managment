"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTournamentPermission } from "@/lib/guard";
import { entityRefusal, ownershipRefusal, refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { delayOrderOfPlay, drawPlacement, generateGroupTies, lockLineups, resetPlacement, scheduleTie, type DrawReport } from "@/lib/tennis/tieOps";
import { applyTieLineups, lineupActor } from "@/lib/tennis/lineupServer";
import { zonedToIso } from "@/lib/tennis/ties";

const path = (id: string) => `/admin/tournaments/${id}/ties`;

export type TieFormState = { ok: boolean; message: string; warnings?: { key: string; message: string; reg: string | null }[] } | null;

export async function generateTiesAction(formData: FormData) {
  const id = String(formData.get("tournament_id"));
  const role = (await requireTournamentPermission("manage_groups", id)).staff.role;
  refuse(await tournamentRowRefusal(id));
  // Confirming the draw also makes every team's coach code (owner's decision, 20 Oct 2026).
  const report: DrawReport = {};
  await generateGroupTies(id, role, report);
  revalidatePath(path(id));
  revalidatePath("/admin/org/coaches");
  if (report.coachCodesCreated) redirect(`${path(id)}?coachCodes=${report.coachCodesCreated}`);
}

export async function saveLineupAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const id = String(formData.get("tournament_id"));
  const { staff } = await requireTournamentPermission("manage_teams", id);
  const tieId = String(formData.get("tie_id") ?? "");
  // The tie must be this tournament's: the posted tournament id alone proves nothing about it.
  const refusal = await entityRefusal(id, "ties", tieId);
  if (refusal) return { ok: false, message: refusal };
  const side = String(formData.get("side")) === "B" ? "B" : "A";
  const v = (k: string) => String(formData.get(k) ?? "") || null;
  const actor = lineupActor(staff) ?? { kind: "organiser" as const, label: "The tournament desk" };
  const result = await applyTieLineups({
    actor,
    actorRole: staff.role,
    tournamentId: id,
    tieId,
    lineups: { [side]: { S1: v("S1"), S2: v("S2"), D: [v("D1"), v("D2")] } },
    accept: formData.getAll("accept").map(String).slice(0, 20),
    reason: String(formData.get("reason") ?? "").trim() || null,
    via: "desk",
  });
  revalidatePath(path(id));
  if (result.ok) return { ok: true, message: result.accepted.length ? "Line-up saved with the exception accepted; the master referees were told." : "Line-up saved." };
  return { ok: false, message: result.message, warnings: result.warnings.map((w) => ({ key: w.key, message: w.message, reg: w.reg })) };
}

export async function lockLineupsAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const id = String(formData.get("tournament_id"));
  const role = (await requireTournamentPermission("manage_teams", id)).staff.role;
  const tieId = String(formData.get("tie_id") ?? "");
  const refusal = await entityRefusal(id, "ties", tieId);
  if (refusal) return { ok: false, message: refusal };
  const result = await lockLineups(id, tieId, role);
  revalidatePath(path(id));
  return result.ok ? { ok: true, message: "Line-ups locked." } : { ok: false, message: result.message };
}

export async function drawPlacementAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const id = String(formData.get("tournament_id"));
  const role = (await requireTournamentPermission("manage_groups", id)).staff.role;
  refuse(await tournamentRowRefusal(id));
  const swap = (k: string) => formData.get(k) === "swap";
  const lots = Object.fromEntries(
    ["1", "9"].map((d) => [d, { top: swap(`lot_${d}_top`), bottom: swap(`lot_${d}_bottom`) }]),
  );
  const result = await drawPlacement(id, role, lots);
  revalidatePath(path(id));
  return result.ok ? { ok: true, message: `Placement draws made: ${result.ties} ties.` } : { ok: false, message: result.message };
}

export async function resetPlacementAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const id = String(formData.get("tournament_id"));
  const role = (await requireTournamentPermission("manage_groups", id)).staff.role;
  refuse(await tournamentRowRefusal(id));
  const result = await resetPlacement(id, role);
  revalidatePath(path(id));
  return result.ok ? { ok: true, message: "Placement draws removed." } : { ok: false, message: result.message };
}

export async function delayOrderOfPlayAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const id = String(formData.get("tournament_id"));
  const role = (await requireTournamentPermission("manage_groups", id)).staff.role;
  refuse(await tournamentRowRefusal(id));
  const minutes = Number(formData.get("minutes"));
  // Only ever a filter on this tournament's own ties and rubbers (delayOrderOfPlay); never written.
  const courtId = String(formData.get("court_id") ?? "") || null;
  const result = await delayOrderOfPlay(id, minutes, courtId, role);
  revalidatePath(path(id));
  if (!result.ok) return { ok: false, message: result.message };
  const moved = `${result.ties} tie${result.ties === 1 ? "" : "s"} and ${result.rubbers} rubber${result.rubbers === 1 ? "" : "s"}`;
  return { ok: true, message: `${moved} moved ${minutes > 0 ? "back" : "forward"} ${Math.abs(minutes)} minutes.` };
}

export async function scheduleTieAction(_prev: TieFormState, formData: FormData): Promise<TieFormState> {
  const id = String(formData.get("tournament_id"));
  const role = (await requireTournamentPermission("manage_groups", id)).staff.role;
  const tieId = String(formData.get("tie_id") ?? "");
  const courtId = String(formData.get("court_id") ?? "") || null;
  const refusal = (await entityRefusal(id, "ties", tieId)) ?? (courtId ? await ownershipRefusal(id, "courts", courtId) : null);
  if (refusal) return { ok: false, message: refusal };
  const local = String(formData.get("scheduled_local") ?? "").trim();
  const at = local ? zonedToIso(local) : null;
  if (local && !at) return { ok: false, message: "That time could not be read." };
  const result = await scheduleTie(id, tieId, courtId, at, role);
  revalidatePath(path(id));
  return result.ok ? { ok: true, message: "Court and time saved." } : { ok: false, message: result.message };
}
