"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requireOrgPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { PHOTO_TYPES, uploadImage } from "@/lib/upload";
import { cleanColors, cleanText, cleanVenues, isLogoUrl, nameKey, ORG_LIMITS } from "@/lib/orgs/profile";
import { orgNameRefusal } from "@/lib/orgs/names";
import type { FormState } from "@/components/StateForm";

const PATH = "/admin/org/profile";
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
/** Logos are drawn small; a bigger image (or one whose size cannot be read) is refused. */
const LOGO_MAX_PIXELS = 2048;

/**
 * The organisation's public profile and branding. Only the organisation the
 * caller is signed in for: a posted organisation id that is not the caller's is
 * refused ("Not found"). The logo is checked on the server (raster types only,
 * its bytes sniffed, 2 MB, at most 2048 px a side), never trusted from the browser.
 *
 * A new name is checked (no web address, not Move Beyond's, not another
 * organisation's) and then waits for a platform admin's approval
 * (organizations.pending_name); the public name stays as it is meanwhile. A
 * change of case or spacing only applies at once. Platform admins rename directly.
 */
export async function updateOrgProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireOrgPermission(String(formData.get("organization_id") ?? ""), "manage_org_profile");
  const name = cleanText(formData.get("name"), ORG_LIMITS.name);
  if (!name || name.length < 2) return { ok: false, message: "Enter the organisation's name." };
  const colors = cleanColors({ primary: formData.get("color_primary"), accent: formData.get("color_accent") });
  const venues = cleanVenues(
    Array.from({ length: ORG_LIMITS.venues }, (_, i) => ({
      name: formData.get(`venue_${i}_name`),
      address: formData.get(`venue_${i}_address`),
      courts: formData.get(`venue_${i}_courts`),
    })),
  );
  const { data: cur } = await db().from("organizations").select("name, slug, pending_name").eq("id", staff.orgId).maybeSingle();
  const current = cur as { name: string; slug: string; pending_name: string | null } | null;
  if (!current) return { ok: false, message: "Not found" };
  let renameNote = "";
  const nameFields: Record<string, unknown> = {};
  if (name !== current.name) {
    const refused = await orgNameRefusal(name, { id: staff.orgId, slug: current.slug });
    if (refused) return { ok: false, message: refused };
    if (staff.platformAdmin || nameKey(name) === nameKey(current.name)) {
      Object.assign(nameFields, { name, pending_name: null, pending_name_at: null });
    } else if (name !== current.pending_name) {
      Object.assign(nameFields, { pending_name: name, pending_name_at: new Date().toISOString() });
      renameNote = ` The new name "${name}" is waiting for Move Beyond's approval; until then the organisation keeps its name.`;
    }
  }
  const patch: Record<string, unknown> = {
    ...nameFields,
    colors,
    about: cleanText(formData.get("about"), ORG_LIMITS.about, true),
    city: cleanText(formData.get("city"), ORG_LIMITS.city),
    country: cleanText(formData.get("country"), ORG_LIMITS.country),
    venues,
    top_board_opt_out: formData.get("top_board_opt_out") === "on",
    updated_at: new Date().toISOString(),
  };
  const logo = formData.get("logo");
  if (logo instanceof File && logo.size > 0) {
    try {
      const url = await uploadImage(logo, `orgs/${staff.orgId}/logo`, { allow: PHOTO_TYPES, maxBytes: LOGO_MAX_BYTES, maxPixels: LOGO_MAX_PIXELS });
      if (!isLogoUrl(url)) return { ok: false, message: "Could not store the logo. Try again." };
      patch.logo_url = url;
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Could not upload the logo." };
    }
  } else if (formData.get("remove_logo") === "on") {
    patch.logo_url = null;
  }
  const { error } = await db().from("organizations").update(patch).eq("id", staff.orgId);
  if (error) return { ok: false, message: "Could not save. Try again." };
  await audit({
    organization_id: staff.orgId,
    action: "ORGANIZATION_PROFILE_UPDATED",
    entity_type: "organization",
    entity_id: staff.orgId,
    new_value: { name: "name" in nameFields ? name : current.name, pending_name: nameFields.pending_name ?? undefined, colors, venues: venues.length, logo: "logo_url" in patch ? (patch.logo_url ? "changed" : "removed") : "unchanged" },
  });
  revalidatePath(PATH);
  return { ok: true, message: `Saved. The app shows it on the organisation's page; its colours and logo are the default look of its tournaments.${renameNote}` };
}
