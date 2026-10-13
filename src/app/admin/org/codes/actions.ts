"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requireScopedPermission, requireStaffPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { formatEventCode, generateEventCode, hashEventCode } from "@/lib/orgs/codes";
import { isCodeRole } from "@/lib/orgs/roles";

const PATH = "/admin/org/codes";

export type CodeFormState = { ok: true; code: string; role: string; label: string | null } | { ok: false; message: string } | null;

/**
 * A new event code for a referee or a TV operator. The code is shown once, here;
 * only its SHA-256 hash is stored, and it is never written to the audit log.
 */
export async function createEventCode(_prev: CodeFormState, formData: FormData): Promise<CodeFormState> {
  const staff = await requireStaffPermission("manage_codes");
  const role = String(formData.get("role") ?? "");
  if (!isCodeRole(role)) return { ok: false, message: "Pick referee or screen operator." };
  const tournamentId = String(formData.get("tournament_id") ?? "").trim() || null;
  // An optional scope: one of this organisation's own tournaments or sessions.
  if (tournamentId) await requireScopedPermission("manage_codes", { tournament: tournamentId });
  const label = String(formData.get("label") ?? "").trim().slice(0, 80) || null;
  const days = parseInt(String(formData.get("expires_days") ?? ""), 10);
  const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + Math.min(days, 365) * 86_400_000).toISOString() : null;

  const code = generateEventCode();
  const { data, error } = await db()
    .from("organization_codes")
    .insert({
      organization_id: staff.orgId,
      role,
      tournament_id: tournamentId,
      code_hash: hashEventCode(code),
      label,
      expires_at: expiresAt,
      created_by: staff.userId,
      created_by_role: staff.orgRole,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, message: "Could not create the code. Try again." };
  await audit({
    organization_id: staff.orgId,
    tournament_id: tournamentId,
    action: "EVENT_CODE_CREATED",
    entity_type: "organization_code",
    entity_id: (data as { id: string }).id,
    new_value: { role, label, scoped: Boolean(tournamentId), expires_at: expiresAt },
  });
  revalidatePath(PATH);
  return { ok: true, code: formatEventCode(code), role, label };
}

/** Revokes a code: the next request made with it fails, on the web and in the app. */
export async function revokeEventCode(formData: FormData) {
  const id = String(formData.get("code_id") ?? "");
  // The code's own organisation decides, not anything posted with it.
  const { staff } = await requireScopedPermission("manage_codes", { code: id });
  await db()
    .from("organization_codes")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", staff.orgId)
    .is("revoked_at", null);
  await audit({ organization_id: staff.orgId, action: "EVENT_CODE_REVOKED", entity_type: "organization_code", entity_id: id });
  revalidatePath(PATH);
}
