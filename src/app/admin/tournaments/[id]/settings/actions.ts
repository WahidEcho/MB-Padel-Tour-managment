"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { uploadImage } from "@/lib/upload";
import { getTournament } from "@/lib/data";
import type { BrandingConfig } from "@/lib/types";

function settingsPath(id: string) {
  return `/admin/tournaments/${id}/settings`;
}

export async function updateGeneral(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  const name = String(formData.get("name") ?? "").trim();
  const lowerThird = String(formData.get("lower_third_text") ?? "").trim();
  if (!name) throw new Error("Name required");
  await db()
    .from("tournaments")
    .update({ name, lower_third_text: lowerThird, updated_at: new Date().toISOString() })
    .eq("id", id);
  await audit({ tournament_id: id, actor_role: role, action: "TOURNAMENT_SETTINGS_UPDATED" });
  revalidatePath(settingsPath(id));
}

export async function updateScoring(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  const t = await getTournament(id);
  if (!t) throw new Error("Not found");
  const num = (key: string, fallback: number) =>
    Math.max(1, parseInt(String(formData.get(key) ?? ""), 10) || fallback);
  const scoring = {
    ...t.scoring_config,
    setsToWinMatch: num("setsToWinMatch", 1),
    gamesToWinSet: num("gamesToWinSet", 6),
    tiebreakEnabled: formData.get("tiebreakEnabled") === "on",
    tiebreakAtGames: num("tiebreakAtGames", 6),
    tiebreakTargetPoints: num("tiebreakTargetPoints", 7),
    tiebreakWinByTwo: formData.get("tiebreakWinByTwo") === "on",
    walkoverScore: String(formData.get("walkoverScore") ?? "6-0"),
  };
  const format = {
    ...t.format_config,
    qualifyPerGroup: num("qualifyPerGroup", 2),
    thirdPlaceMatch: formData.get("thirdPlaceMatch") === "on",
  };
  await db()
    .from("tournaments")
    .update({ scoring_config: scoring, format_config: format, updated_at: new Date().toISOString() })
    .eq("id", id);
  await audit({
    tournament_id: id,
    actor_role: role,
    action: "SCORING_CONFIG_UPDATED",
    new_value: scoring,
  });
  revalidatePath(settingsPath(id));
}

export async function addCourt(formData: FormData) {
  await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  const name = String(formData.get("court_name") ?? "").trim();
  if (!name) throw new Error("Court name required");
  const { count } = await db().from("courts").select("*", { count: "exact", head: true }).eq("tournament_id", id);
  if ((count ?? 0) >= 20) throw new Error("Maximum 20 courts");
  await db().from("courts").insert({ tournament_id: id, court_name: name, court_order: (count ?? 0) + 1 });
  revalidatePath(settingsPath(id));
}

export async function removeCourt(formData: FormData) {
  await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  const courtId = String(formData.get("court_id"));
  await db().from("courts").delete().eq("id", courtId);
  revalidatePath(settingsPath(id));
}

export async function uploadBranding(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  const t = await getTournament(id);
  if (!t) throw new Error("Not found");
  const branding: BrandingConfig = { ...t.branding_config };

  const single: [string, keyof BrandingConfig][] = [
    ["move_beyond_logo", "moveBeyondLogoUrl"],
    ["client_logo", "clientLogoUrl"],
    ["event_logo", "eventLogoUrl"],
    ["background", "backgroundUrl"],
  ];
  for (const [field, key] of single) {
    const file = formData.get(field);
    if (file instanceof File && file.size > 0) {
      (branding[key] as string) = await uploadImage(file, `branding/${id}`);
    }
  }
  const sponsors = formData.getAll("sponsor_logos").filter((f): f is File => f instanceof File && f.size > 0);
  if (sponsors.length > 0) {
    const urls = branding.sponsorLogoUrls ?? [];
    for (const f of sponsors) urls.push(await uploadImage(f, `branding/${id}/sponsors`));
    branding.sponsorLogoUrls = urls;
  }
  if (formData.get("clear_sponsors") === "on") branding.sponsorLogoUrls = [];

  await db()
    .from("tournaments")
    .update({ branding_config: branding, updated_at: new Date().toISOString() })
    .eq("id", id);
  await audit({ tournament_id: id, actor_role: role, action: "BRANDING_UPDATED" });
  revalidatePath(settingsPath(id));
}
