"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requireScopedPermission, requireStaffPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { formatEventCode, generateEventCode, hashEventCode } from "@/lib/orgs/codes";
import { createReferee, removeReferee, resetRefereePin } from "@/lib/referees/server";
import { actOnCall } from "@/lib/referees/assistance";
import { isRefereeRole } from "@/lib/referees/rules";

const PATH = "/admin/org/referees";

export type RefereeFormState =
  | { ok: true; name: string; pin: string; role: string; code?: string; scope?: string | null; expiresAt?: string | null }
  | { ok: false; message: string }
  | null;

const text = (v: FormDataEntryValue | null, max: number) => String(v ?? "").trim().slice(0, max) || null;

/**
 * A new referee (or master referee) of the organisation. The system makes a 4-digit
 * PIN, unique among the organisation's active referees, shown once here: only its
 * peppered hash is kept, and it is never written to the audit log.
 */
export async function createRefereeAction(_prev: RefereeFormState, formData: FormData): Promise<RefereeFormState> {
  const staff = await requireStaffPermission("manage_referees");
  const name = text(formData.get("name"), 80);
  if (!name) return { ok: false, message: "Enter the referee's name." };
  const role = String(formData.get("role") ?? "referee");
  if (!isRefereeRole(role)) return { ok: false, message: "Pick referee or master referee." };
  const phone = text(formData.get("phone"), 32);
  if (phone && !/^\+?[0-9 ()-]{6,32}$/.test(phone)) return { ok: false, message: "That phone number does not look right." };
  const photoUrl = text(formData.get("photo_url"), 500);
  if (photoUrl && !/^https?:\/\/\S+$/.test(photoUrl)) return { ok: false, message: "The photo must be a link (https://…)." };
  const groupId = text(formData.get("event_group_id"), 40);
  // The event group must be this organisation's own.
  if (groupId) await requireScopedPermission("manage_referees", { eventGroup: groupId });
  const made = await createReferee(staff.orgId, { name, phone, photoUrl, role, eventGroupId: groupId }, { userId: staff.userId, orgRole: staff.orgRole });
  if (!made.ok) return made;
  await audit({
    organization_id: staff.orgId,
    action: "REFEREE_CREATED",
    entity_type: "referee",
    entity_id: made.referee.id,
    new_value: { name, role, event_group_id: groupId, phone: Boolean(phone), photo: Boolean(photoUrl) },
  });
  revalidatePath(PATH);
  return { ok: true, name, pin: made.pin, role };
}

/** A new PIN for a referee (the old one stops working; every sign-in of theirs ends). Shown once. */
export async function resetRefereePinAction(_prev: RefereeFormState, formData: FormData): Promise<RefereeFormState> {
  const id = String(formData.get("referee_id") ?? "");
  const { staff } = await requireScopedPermission("manage_referees", { referee: id });
  const r = await resetRefereePin(staff.orgId, id);
  if (!r.ok) return r;
  await audit({ organization_id: staff.orgId, action: "REFEREE_PIN_RESET", entity_type: "referee", entity_id: id, new_value: { name: r.referee.name } });
  revalidatePath(PATH);
  return { ok: true, name: r.referee.name, pin: r.pin, role: r.referee.role };
}

/** Removes a referee: their PIN stops working at once, their sign-ins end, their master codes are revoked. */
export async function removeRefereeAction(formData: FormData) {
  const id = String(formData.get("referee_id") ?? "");
  const { staff } = await requireScopedPermission("manage_referees", { referee: id });
  const done = await removeReferee(staff.orgId, id);
  if (done) await audit({ organization_id: staff.orgId, action: "REFEREE_REMOVED", entity_type: "referee", entity_id: id });
  revalidatePath(PATH);
}

/**
 * A master referee's personal code (with their PIN, it signs them in to every court of
 * the event group, or of the organisation's open events). Shown once, like event codes.
 */
export async function createMasterCodeAction(_prev: RefereeFormState, formData: FormData): Promise<RefereeFormState> {
  const id = String(formData.get("referee_id") ?? "");
  const { staff } = await requireScopedPermission("manage_codes", { referee: id });
  const { data: r } = await db().from("referees").select("id, name, role, status, event_group_id").eq("id", id).eq("organization_id", staff.orgId).maybeSingle();
  const ref = r as { id: string; name: string; role: string; status: string; event_group_id: string | null } | null;
  if (!ref || ref.status !== "active") return { ok: false, message: "Not found" };
  if (ref.role !== "master_referee") return { ok: false, message: "Only a master referee gets a master code." };
  const groupId = text(formData.get("event_group_id"), 40) ?? ref.event_group_id;
  let scopeName: string | null = null;
  if (groupId) {
    await requireScopedPermission("manage_codes", { eventGroup: groupId });
    const { data: g } = await db().from("event_groups").select("name").eq("id", groupId).eq("organization_id", staff.orgId).maybeSingle();
    scopeName = (g as { name: string } | null)?.name ?? null;
  }
  const days = parseInt(String(formData.get("expires_days") ?? "7"), 10);
  const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + Math.min(days, 90) * 86_400_000).toISOString() : null;
  const code = generateEventCode();
  let codeHash: string;
  try {
    codeHash = hashEventCode(code);
  } catch (err) {
    console.error("event codes unavailable:", (err as Error).message);
    return { ok: false, message: "Event codes are not set up on this server yet (EVENT_CODE_PEPPER). Contact Move Beyond." };
  }
  const { data, error } = await db()
    .from("organization_codes")
    .insert({
      organization_id: staff.orgId,
      role: "master_referee",
      referee_id: ref.id,
      event_group_id: groupId,
      code_hash: codeHash,
      label: `${ref.name} (master referee)`.slice(0, 80),
      expires_at: expiresAt,
      created_by: staff.userId,
      created_by_role: staff.orgRole,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, message: "Could not create the code. Try again." };
  await audit({
    organization_id: staff.orgId,
    action: "EVENT_CODE_CREATED",
    entity_type: "organization_code",
    entity_id: (data as { id: string }).id,
    new_value: { role: "master_referee", referee_id: ref.id, event_group_id: groupId, expires_at: expiresAt },
  });
  revalidatePath(PATH);
  revalidatePath("/admin/org/codes");
  const expiresLabel = expiresAt ? new Date(expiresAt).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }) : null;
  return { ok: true, name: ref.name, pin: "", role: "master_referee", code: formatEventCode(code), scope: scopeName, expiresAt: expiresLabel };
}

/** The organiser closes a call for assistance (resolved), from the calls log. */
export async function resolveCallAction(formData: FormData) {
  const id = String(formData.get("call_id") ?? "");
  const { staff } = await requireScopedPermission("manage_referees", { assistanceCall: id });
  const out = await actOnCall(staff, id, "resolve");
  if (out.ok) await audit({ organization_id: staff.orgId, tournament_id: out.call.tournament_id, action: "ASSISTANCE_RESOLVED", entity_type: "assistance_call", entity_id: id, new_value: { court: out.call.court_name } });
  revalidatePath(`${PATH}/calls`);
}
