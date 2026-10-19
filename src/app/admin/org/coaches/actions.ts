"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireScopedPermission, requireTournamentPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { courtCodeEvent } from "@/lib/orgs/courtCodes";
import { zonedToIso } from "@/lib/tennis/ties";
import { coachCodeWorks, coachCodesOf, coachEventTeams, endCoachSessionsOf, newCoachCodeRow } from "@/lib/coaches/server";

const PATH = "/admin/org/coaches";

/** Without dates on the event, a coach code still ends by itself: two weeks after it is made. */
const NO_DATES_DAYS = 14;

/** When a team's code stops working: the end of its own event's last day (Cairo), else two weeks from now. */
function eventEnd(row: { ends_on: string | null; starts_on: string | null } | undefined, now = Date.now()): string {
  const day = row?.ends_on ?? row?.starts_on ?? null;
  const at = day ? zonedToIso(`${day}T23:59`) : null;
  return at && Date.parse(at) > now ? at : new Date(now + NO_DATES_DAYS * 86_400_000).toISOString();
}

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
  const [teams, existing, { data: dates }] = await Promise.all([
    coachEventTeams(ev),
    coachCodesOf(staff.orgId, ev),
    db().from("tournaments").select("id, ends_on, starts_on").eq("organization_id", staff.orgId).in("id", ev.tournaments.map((t) => t.id)),
  ]);
  const dateOf = new Map(((dates ?? []) as { id: string; ends_on: string | null; starts_on: string | null }[]).map((d) => [d.id, d]));
  const nameOf = new Map(ev.tournaments.map((t) => [t.id, t.name]));
  const covered = new Set(existing.filter((c) => coachCodeWorks(c)).map((c) => c.team_id));
  // An expired code that was never revoked still holds its team's one slot: revoke it first.
  const stale = existing.filter((c) => !c.revoked_at && !coachCodeWorks(c)).map((c) => c.id);
  if (stale.length) await db().from("coach_codes").update({ revoked_at: new Date().toISOString() }).eq("organization_id", staff.orgId).in("id", stale);
  const rows = teams
    .filter((t) => t.team_status !== "withdrawn" && !covered.has(t.id))
    .map((t) =>
      newCoachCodeRow({ orgId: staff.orgId, team: t, eventName: nameOf.get(t.tournament_id) ?? ev.title, expiresAt: eventEnd(dateOf.get(t.tournament_id)), createdBy: staff.userId, createdByRole: staff.orgRole }).row,
    );
  if (rows.length) {
    const { data, error } = await db().from("coach_codes").insert(rows.map((r) => ({ ...r, organization_id: staff.orgId }))).select("id, tournament_id, team_id, expires_at");
    if (error) throw new Error("Could not create the coach codes. Try again.");
    for (const r of (data ?? []) as { id: string; tournament_id: string; team_id: string; expires_at: string | null }[]) {
      // Never the code itself: which team, and until when.
      await audit({ organization_id: staff.orgId, tournament_id: r.tournament_id, action: "COACH_CODE_CREATED", entity_type: "coach_code", entity_id: r.id, new_value: { team_id: r.team_id, expires_at: r.expires_at } });
    }
  }
  revalidatePath(PATH);
  redirect(`${PATH}?event=${ev.tournamentId}&made=${rows.length}`);
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
  const expiresAt = old.expires_at && Date.parse(old.expires_at) > Date.now() ? old.expires_at : eventEnd(tr);
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
