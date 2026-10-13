"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requireOrgPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { PHOTO_TYPES, uploadImage } from "@/lib/upload";
import { cleanColors, cleanText, cleanVenues, isLogoUrl, ORG_LIMITS } from "@/lib/orgs/profile";
import type { FormState } from "@/components/StateForm";

const PATH = "/admin/org/profile";
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The organisation's public profile and branding. Only the organisation the
 * caller is signed in for: a posted organisation id that is not the caller's is
 * refused ("Not found"). The logo is checked on the server (raster types only,
 * its bytes sniffed, 2 MB), never trusted from the browser.
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
  const patch: Record<string, unknown> = {
    name,
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
      const url = await uploadImage(logo, `orgs/${staff.orgId}/logo`, { allow: PHOTO_TYPES, maxBytes: LOGO_MAX_BYTES });
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
    new_value: { name, colors, venues: venues.length, logo: "logo_url" in patch ? (patch.logo_url ? "changed" : "removed") : "unchanged" },
  });
  revalidatePath(PATH);
  return { ok: true, message: "Saved. The app shows it on the organisation's page; its colours and logo are the default look of its tournaments." };
}
