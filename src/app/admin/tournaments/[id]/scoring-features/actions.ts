"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requireTournamentPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { refuse, tournamentOrSessionRefusal } from "@/lib/rowGuards";
import { SCORING_FEATURES_ON, matchDayRules } from "@/lib/matchday/rules";

/**
 * Scoring v2 feature switches (Fault, Ace, Let, timers, swaps, match log, doubles
 * order, call master, TV extras). Admins only: a manager, a master referee or a
 * referee cannot change them. Stored in `match_day_rules.features` (no migration);
 * the referee bootstrap delivers them and the events route enforces them.
 */
export async function saveScoringFeatures(formData: FormData) {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff } = await requireTournamentPermission("manage_tournament", id);
  if (staff.role !== "admin" && !staff.platformAdmin) throw new Error("Only admins can change the scoring features.");
  refuse(await tournamentOrSessionRefusal(id));
  const { data: t } = await db().from("tournaments").select("sport, match_day_rules").eq("id", id).single();
  const row = t as { sport: string; match_day_rules: Record<string, unknown> | null } | null;
  if (!row) throw new Error("Tournament not found.");
  const intent = String(formData.get("intent") ?? "save");
  const features = Object.fromEntries(
    Object.keys(SCORING_FEATURES_ON).map((k) => [k, intent === "all_on" ? true : intent === "all_off" ? false : formData.get(k) === "on"]),
  );
  const next = { ...(row.match_day_rules ?? {}), features };
  const { error } = await db().from("tournaments").update({ match_day_rules: next, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
  await audit({
    tournament_id: id,
    actor_role: staff.role,
    action: "SCORING_FEATURES_EDITED",
    entity_type: "tournament",
    entity_id: id,
    old_value: matchDayRules(row.match_day_rules, row.sport).features,
    new_value: features,
  });
  revalidatePath(`/admin/tournaments/${id}/scoring-features`);
}
