"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { refuse, tournamentOrSessionRefusal } from "@/lib/rowGuards";
import { DEFAULT_MATCH_DAY_RULES, matchDayRules, type MatchDayRules } from "@/lib/matchday/rules";

const path = (id: string) => `/admin/tournaments/${id}/match-day`;

/** The form's fields back into a rules object: `group.key` names, shaped like the defaults. */
function rulesFromForm(formData: FormData): Record<string, unknown> {
  const raw: Record<string, unknown> = { configured: true };
  for (const [g, fields] of Object.entries(DEFAULT_MATCH_DAY_RULES)) {
    if (typeof fields !== "object" || fields === null) continue;
    const out: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(fields)) {
      const v = formData.get(`${g}.${k}`);
      if (typeof def === "boolean") out[k] = v === "on";
      else if (typeof def === "number") out[k] = Number(String(v ?? "").slice(0, 4));
      else if (typeof v === "string") out[k] = v.slice(0, 20);
    }
    raw[g] = out;
  }
  return raw;
}

/**
 * Saves the tournament's match-day rules. Sessions run by them too, so this uses
 * the session-aware refusal: any real tournament or session row, nothing else.
 * intent "defaults" stores the recommended set; "off" stores `{}` (all off, as
 * before match day existed).
 */
export async function saveMatchDayRules(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id") ?? "");
  refuse(await tournamentOrSessionRefusal(id));
  const { data: t } = await db().from("tournaments").select("sport, match_day_rules").eq("id", id).single();
  const row = t as { sport: string; match_day_rules: Record<string, unknown> | null } | null;
  if (!row) throw new Error("Tournament not found.");
  const intent = String(formData.get("intent") ?? "save");
  const next: MatchDayRules | Record<string, never> =
    intent === "off"
      ? {}
      : matchDayRules(intent === "defaults" ? DEFAULT_MATCH_DAY_RULES : rulesFromForm(formData), row.sport);
  const { error } = await db()
    .from("tournaments")
    .update({ match_day_rules: next, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
  await audit({
    tournament_id: id,
    actor_role: role,
    action: "MATCH_DAY_RULES_EDITED",
    entity_type: "tournament",
    entity_id: id,
    old_value: row.match_day_rules ?? {},
    new_value: next,
  });
  revalidatePath(path(id));
}
