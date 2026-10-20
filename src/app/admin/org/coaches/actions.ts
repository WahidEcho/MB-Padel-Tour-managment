"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireScopedPermission, requireTournamentPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { courtCodeEvent } from "@/lib/orgs/courtCodes";
import { endCoachSessionsOf, newCoachCodeRow } from "@/lib/coaches/server";
import { coachCodeExpiry, ensureCoachCodes } from "@/lib/coaches/autoCodes";
import { coachLineupSettings, deadlineFrom } from "@/lib/coaches/lineupEntry";

const PATH = "/admin/org/coaches";

/**
 * One click: a coach code for every team of the event (both events of its group) that has
 * no working code yet. One code per team: the head coach and the assistants all use it.
 * Each is sealed so its card can be printed again; only the hash signs in. Codes work until
 * their own event ends. Admins only (manage_coaches).
 */
export async function createCoachCodesAction(formData: FormData) {
  const tournamentId = String(formData.get("tournament_id") ?? "");
  // The tournament's own organisation decides (another organisation's: not found).
  const { staff } = await requireTournamentPermission("manage_coaches", tournamentId);
  const ev = await courtCodeEvent(staff.orgId, tournamentId);
  if (!ev) throw new Error("Not found");
  const made = await ensureCoachCodes({ orgId: staff.orgId, tournamentIds: ev.tournaments.map((t) => t.id), createdBy: staff.userId, createdByRole: staff.orgRole, via: "button" });
  revalidatePath(PATH);
  redirect(`${PATH}?event=${ev.tournamentId}&made=${made.created}`);
}

/**
 * A new code for one team (a lost card, a code passed on): the old code stops working on
 * its next request and its phones stop getting alerts. Same team and expiry; print its card again.
 */
export async function regenerateCoachCodeAction(formData: FormData) {
  const id = String(formData.get("code_id") ?? "");
  // The code's own organisation decides, not anything posted with it.
  const { staff } = await requireScopedPermission("manage_coaches", { coachCode: id });
  const { data } = await db().from("coach_codes").select("id, tournament_id, team_id, label, expires_at, revoked_at").eq("id", id).eq("organization_id", staff.orgId).maybeSingle();
  const old = data as { id: string; tournament_id: string; team_id: string; label: string | null; expires_at: string | null; revoked_at: string | null } | null;
  if (!old) throw new Error("Not found");
  await db().from("coach_codes").update({ revoked_at: new Date().toISOString() }).eq("id", id).eq("organization_id", staff.orgId).is("revoked_at", null);
  await endCoachSessionsOf(id, "replaced");
  const { data: team } = await db().from("teams").select("id, tournament_id, team_name").eq("id", old.team_id).eq("tournament_id", old.tournament_id).maybeSingle();
  const { data: t } = await db().from("tournaments").select("id, name, ends_on, starts_on").eq("id", old.tournament_id).eq("organization_id", staff.orgId).maybeSingle();
  if (!team || !t) throw new Error("Not found");
  const tr = t as { name: string; ends_on: string | null; starts_on: string | null };
  const expiresAt = old.expires_at && Date.parse(old.expires_at) > Date.now() ? old.expires_at : coachCodeExpiry(tr);
  const { row } = newCoachCodeRow({ orgId: staff.orgId, team: team as { id: string; tournament_id: string; team_name: string }, eventName: tr.name, expiresAt, createdBy: staff.userId, createdByRole: staff.orgRole });
  const { data: made, error } = await db().from("coach_codes").insert({ ...row, organization_id: staff.orgId }).select("id").single();
  if (error || !made) throw new Error("Could not make the new code. Try again.");
  await audit({ organization_id: staff.orgId, tournament_id: old.tournament_id, action: "COACH_CODE_REVOKED", entity_type: "coach_code", entity_id: id, new_value: { regenerated: true } });
  await audit({ organization_id: staff.orgId, tournament_id: old.tournament_id, action: "COACH_CODE_CREATED", entity_type: "coach_code", entity_id: (made as { id: string }).id, new_value: { team_id: old.team_id, replaces: id, expires_at: expiresAt } });
  revalidatePath(PATH);
}

/** Revokes a team's code: every device signed in with it is refused on its next request and gets no more alerts. */
export async function revokeCoachCodeAction(formData: FormData) {
  const id = String(formData.get("code_id") ?? "");
  const { staff } = await requireScopedPermission("manage_coaches", { coachCode: id });
  const { data } = await db().from("coach_codes").update({ revoked_at: new Date().toISOString() }).eq("id", id).eq("organization_id", staff.orgId).is("revoked_at", null).select("tournament_id").maybeSingle();
  await endCoachSessionsOf(id, "revoked");
  if (data) await audit({ organization_id: staff.orgId, tournament_id: (data as { tournament_id: string }).tournament_id, action: "COACH_CODE_REVOKED", entity_type: "coach_code", entity_id: id });
  revalidatePath(PATH);
}

/**
 * Coach line-up entry for one event (off by default: "on the shelf" until officially
 * confirmed, owner 20 Oct 2026). On: the team's coaches enter their own line-up until the
 * officials confirm it (or `deadline_minutes` before the tie). Admins only (manage_coaches,
 * and an admin role). Stored in `format_config.ties.coachLineups` (no migration).
 */
export async function saveCoachLineupSettingsAction(formData: FormData) {
  const tournamentId = String(formData.get("tournament_id") ?? "");
  const { staff } = await requireTournamentPermission("manage_coaches", tournamentId);
  if (staff.role !== "admin" && !staff.platformAdmin) throw new Error("Only admins can change coach line-up entry.");
  const ev = await courtCodeEvent(staff.orgId, String(formData.get("event") ?? tournamentId));
  const { data } = await db().from("tournaments").select("id, format_config").eq("id", tournamentId).eq("organization_id", staff.orgId).maybeSingle();
  const t = data as { id: string; format_config: Record<string, unknown> | null } | null;
  if (!t) throw new Error("Not found");
  const ties = t.format_config?.ties as Record<string, unknown> | undefined;
  if (!ties) throw new Error("Coach line-up entry is for nations events (ties) only.");
  const before = coachLineupSettings(t.format_config);
  const on = formData.get("on") === "on";
  const next = { on, deadlineMinutes: deadlineFrom(formData.get("deadline_minutes")), by: staff.userId ?? staff.role, at: new Date().toISOString() };
  const { error } = await db()
    .from("tournaments")
    .update({ format_config: { ...t.format_config, ties: { ...ties, coachLineups: next } }, updated_at: new Date().toISOString() })
    .eq("id", tournamentId)
    .eq("organization_id", staff.orgId);
  if (error) throw new Error(error.message);
  await audit({ organization_id: staff.orgId, tournament_id: tournamentId, action: "COACH_LINEUPS_SWITCHED", entity_type: "tournament", entity_id: tournamentId, old_value: before, new_value: { on, deadlineMinutes: next.deadlineMinutes } });
  revalidatePath(PATH);
  redirect(`${PATH}?event=${ev && ev.tournaments.some((x) => x.id === tournamentId) ? ev.tournamentId : tournamentId}`);
}
