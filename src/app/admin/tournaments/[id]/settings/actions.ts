"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { uploadImage } from "@/lib/upload";
import { getTournament } from "@/lib/data";
import type { BrandingConfig, FormatConfig, MatchRules, ScoringConfig, Stage, StageRuleKey } from "@/lib/types";
import {
  STAGE_RULE_LABELS,
  scoringConfigForMatch,
  validateMatchRules,
} from "@/lib/scoring/rules";
import { validatePodiumSettings } from "@/lib/bracket";

/** A representative stage for each rule bucket, so the bucket can be resolved. */
const STAGE_FOR_KEY: Record<StageRuleKey, Stage> = {
  group: "group",
  quarter_semi: "semi_final",
  final: "final",
  bracket: "knockout",
  plate_quarter_semi: "semi_final",
  plate_final: "final",
  plate_bracket: "knockout",
};

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

export type ScoringFormState = { ok: true } | { ok: false; problems: string[] } | null;

/** The rule buckets the settings form offers, in the order it shows them. */
const STAGE_KEYS: StageRuleKey[] = [
  "group",
  "quarter_semi",
  "final",
  "bracket",
  "plate_quarter_semi",
  "plate_final",
  "plate_bracket",
];

/**
 * Reads one stage's override out of the form. Every field is optional: a blank
 * number or an "inherit" toggle means the bucket takes whatever it inherits, so
 * a tournament that never opens these panels keeps behaving exactly as before.
 */
function readOverride(formData: FormData, key: StageRuleKey): Partial<MatchRules> {
  const raw = (field: string) => String(formData.get(`ov.${key}.${field}`) ?? "").trim();
  const int = (field: string) => {
    const v = raw(field);
    return v === "" ? undefined : parseInt(v, 10);
  };
  const bool = (field: string) => {
    const v = raw(field);
    return v === "" ? undefined : v === "on";
  };
  const out: Partial<MatchRules> = {};
  const sets = int("setsToWinMatch");
  const games = int("gamesToWinSet");
  const tbAt = int("tiebreakAtGames");
  const tbTarget = int("tiebreakTargetPoints");
  const tbOn = bool("tiebreakEnabled");
  const tbTwo = bool("tiebreakWinByTwo");
  const wo = raw("walkoverScore");
  if (sets !== undefined) out.setsToWinMatch = sets;
  if (games !== undefined) out.gamesToWinSet = games;
  if (tbAt !== undefined) out.tiebreakAtGames = tbAt;
  if (tbTarget !== undefined) out.tiebreakTargetPoints = tbTarget;
  if (tbOn !== undefined) out.tiebreakEnabled = tbOn;
  if (tbTwo !== undefined) out.tiebreakWinByTwo = tbTwo;
  if (wo !== "") out.walkoverScore = wo;
  return out;
}

export async function updateScoring(
  _prev: ScoringFormState,
  formData: FormData,
): Promise<ScoringFormState> {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  const t = await getTournament(id);
  if (!t) return { ok: false, problems: ["Tournament not found."] };
  const num = (key: string, fallback: number) =>
    Math.max(1, parseInt(String(formData.get(key) ?? ""), 10) || fallback);

  const base: MatchRules = {
    setsToWinMatch: num("setsToWinMatch", 1),
    gamesToWinSet: num("gamesToWinSet", 6),
    tiebreakEnabled: formData.get("tiebreakEnabled") === "on",
    tiebreakAtGames: num("tiebreakAtGames", 6),
    tiebreakTargetPoints: num("tiebreakTargetPoints", 7),
    tiebreakWinByTwo: formData.get("tiebreakWinByTwo") === "on",
    walkoverScore: String(formData.get("walkoverScore") ?? "6-0"),
  };

  const stageOverrides: Partial<Record<StageRuleKey, Partial<MatchRules>>> = {};
  for (const key of STAGE_KEYS) {
    const over = readOverride(formData, key);
    if (Object.keys(over).length > 0) stageOverrides[key] = over;
  }

  const scoring: ScoringConfig = {
    ...t.scoring_config,
    ...base,
    stageOverrides,
    // Only written when the form actually carries the field, so a form that does
    // not show the toggle cannot clear it.
    ...(formData.has("requireResultConfirmation")
      ? { requireResultConfirmation: formData.get("requireResultConfirmation") === "on" }
      : {}),
  };

  // Validate what each bucket actually resolves to, not the override in isolation:
  // a trigger is only wrong in combination with the set length it inherits.
  const problems: string[] = [];
  for (const p of validateMatchRules(base)) problems.push(`Tournament default — ${p.message}`);
  for (const key of Object.keys(stageOverrides) as StageRuleKey[]) {
    const stage = STAGE_FOR_KEY[key];
    const resolved = scoringConfigForMatch({ scoring_config: scoring }, { stage }, key.startsWith("plate_") ? "plate" : "cup");
    for (const p of validateMatchRules(resolved)) {
      problems.push(`${STAGE_RULE_LABELS[key]} — ${p.message}`);
    }
  }
  const plateEnabled = formData.get("plateEnabled") === "on";
  const depth = (key: string, fallback: 1 | 2 | 3 | 4) => {
    const raw = parseInt(String(formData.get(key) ?? ""), 10);
    return ([1, 2, 3, 4] as number[]).includes(raw) ? (raw as 1 | 2 | 3 | 4) : fallback;
  };
  const format: FormatConfig = {
    ...t.format_config,
    qualifyPerGroup: num("qualifyPerGroup", 2),
    thirdPlaceMatch: formData.get("thirdPlaceMatch") === "on",
    tiers: {
      cup: {
        thirdPlaceMatch: formData.get("thirdPlaceMatch") === "on",
        podiumDepth: depth("cupPodiumDepth", 3),
      },
      plate: {
        enabled: plateEnabled,
        perGroup: Math.max(1, num("platePerGroup", 2)),
        thirdPlaceMatch: formData.get("plateThirdPlaceMatch") === "on",
        podiumDepth: depth("platePodiumDepth", 3),
      },
    },
  };

  // A podium deeper than the bracket can fill would render blank cards on a
  // venue screen, so it is refused here rather than discovered there.
  for (const p of validatePodiumSettings(format)) {
    problems.push(`${p.tier === "plate" ? "Plate" : "Cup"} podium — ${p.message}`);
  }
  if (problems.length > 0) return { ok: false, problems };
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
  return { ok: true };
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
