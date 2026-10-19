"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireScopedPermission, requireTournamentPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { generateEventCode, hashEventCode, sealEventCode } from "@/lib/orgs/codes";
import { codeWorks, courtCodeEvent, courtCodesOf, eventCourts, eventEndExpiry } from "@/lib/orgs/courtCodes";
import { zonedToIso } from "@/lib/tennis/ties";
import { courtCodeLabel, courtKey } from "@/lib/orgs/courtScope";

/**
 * One click: a referee code for every physical court of the event (both events of
 * its group) that has no working court code yet. Each is sealed so its QR sheet
 * can be printed again; only the hash is used to sign in. Codes last the whole
 * event unless an expiry is picked, and are revoked one by one on the list.
 */
export async function createCourtCodesAction(formData: FormData) {
  const tournamentId = String(formData.get("tournament_id") ?? "");
  // The tournament's own organisation decides (another organisation's: not found).
  const { staff } = await requireTournamentPermission("manage_codes", tournamentId);
  const ev = await courtCodeEvent(staff.orgId, tournamentId);
  if (!ev) throw new Error("Not found");
  // Default (owner's decision): until the event ends; or never; or after some days.
  const choice = String(formData.get("expires") ?? "event_end");
  const days = parseInt(choice, 10);
  const expiresAt =
    choice === "event_end" ? eventEndExpiry(ev, (l) => zonedToIso(l)) : Number.isFinite(days) && days > 0 ? new Date(Date.now() + Math.min(days, 60) * 86_400_000).toISOString() : null;
  const [courts, existing] = await Promise.all([eventCourts(ev), courtCodesOf(staff.orgId, ev)]);
  const covered = new Set(existing.filter((c) => codeWorks(c)).map((c) => courtKey(c.court_name)));
  const rows = [];
  for (const court of courts) {
    if (covered.has(court.key)) continue;
    const code = generateEventCode();
    rows.push({
      organization_id: staff.orgId,
      role: "referee",
      tournament_id: ev.eventGroupId ? null : ev.tournamentId,
      event_group_id: ev.eventGroupId,
      court_name: court.name,
      code_hash: hashEventCode(code),
      code_sealed: sealEventCode(code),
      label: courtCodeLabel(court.name),
      expires_at: expiresAt,
      created_by: staff.userId,
      created_by_role: staff.orgRole,
    });
  }
  if (rows.length) {
    const { data, error } = await db().from("organization_codes").insert(rows.map((r) => ({ ...r, organization_id: staff.orgId }))).select("id, court_name");
    if (error) throw new Error("Could not create the court codes. Try again.");
    for (const r of (data ?? []) as { id: string; court_name: string }[]) {
      await audit({
        organization_id: staff.orgId,
        tournament_id: ev.eventGroupId ? null : ev.tournamentId,
        action: "EVENT_CODE_CREATED",
        entity_type: "organization_code",
        entity_id: r.id,
        new_value: { role: "referee", court: r.court_name, event_group_id: ev.eventGroupId, expires_at: expiresAt },
      });
    }
  }
  revalidatePath("/admin/org/codes");
  revalidatePath("/admin/org/codes/courts");
  redirect(`/admin/org/codes/courts?event=${ev.tournamentId}&made=${rows.length}`);
}

/**
 * A new code for one court (the old one stops working on its next request): for a
 * lost or shared sheet. Same court, event and expiry; print that court's page again.
 */
export async function regenerateCourtCodeAction(formData: FormData) {
  const id = String(formData.get("code_id") ?? "");
  // The code's own organisation decides, not anything posted with it.
  const { staff } = await requireScopedPermission("manage_codes", { code: id });
  const { data } = await db()
    .from("organization_codes")
    .select("id, court_name, tournament_id, event_group_id, expires_at, revoked_at")
    .eq("id", id)
    .eq("organization_id", staff.orgId)
    .maybeSingle();
  const old = data as { id: string; court_name: string | null; tournament_id: string | null; event_group_id: string | null; expires_at: string | null; revoked_at: string | null } | null;
  if (!old?.court_name) throw new Error("Not found");
  await db().from("organization_codes").update({ revoked_at: new Date().toISOString() }).eq("id", id).eq("organization_id", staff.orgId).is("revoked_at", null);
  const code = generateEventCode();
  const { data: made, error } = await db()
    .from("organization_codes")
    .insert({
      organization_id: staff.orgId,
      role: "referee",
      tournament_id: old.tournament_id,
      event_group_id: old.event_group_id,
      court_name: old.court_name,
      code_hash: hashEventCode(code),
      code_sealed: sealEventCode(code),
      label: courtCodeLabel(old.court_name),
      expires_at: old.expires_at && Date.parse(old.expires_at) > Date.now() ? old.expires_at : null,
      created_by: staff.userId,
      created_by_role: staff.orgRole,
    })
    .select("id")
    .single();
  if (error || !made) throw new Error("Could not make the new code. Try again.");
  await audit({ organization_id: staff.orgId, action: "EVENT_CODE_REVOKED", entity_type: "organization_code", entity_id: id, new_value: { regenerated: true } });
  await audit({ organization_id: staff.orgId, action: "EVENT_CODE_CREATED", entity_type: "organization_code", entity_id: (made as { id: string }).id, new_value: { role: "referee", court: old.court_name, replaces: id } });
  revalidatePath("/admin/org/codes");
  revalidatePath("/admin/org/codes/courts");
}
