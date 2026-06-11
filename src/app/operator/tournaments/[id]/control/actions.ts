"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { getScreenSettings } from "@/lib/data";

export async function updateScreen(formData: FormData) {
  const role = await requirePermission("control_screen");
  const tournamentId = String(formData.get("tournament_id"));
  const settings = await getScreenSettings(tournamentId);

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const mode = formData.get("display_mode");
  if (mode) update.display_mode = String(mode);
  const theme = formData.get("theme");
  if (theme) update.theme = String(theme);
  if (formData.has("focus_court_id")) update.focus_court_id = String(formData.get("focus_court_id")) || null;
  const rotation = formData.get("sponsor_rotation_seconds");
  if (rotation) update.sponsor_rotation_seconds = Math.max(3, parseInt(String(rotation), 10) || 10);

  await db().from("screen_settings").update(update).eq("id", settings.id);
  await audit({
    tournament_id: tournamentId,
    actor_role: role,
    action: "SCREEN_SETTINGS_CHANGED",
    new_value: update,
  });
  revalidatePath(`/operator/tournaments/${tournamentId}/control`);
}
