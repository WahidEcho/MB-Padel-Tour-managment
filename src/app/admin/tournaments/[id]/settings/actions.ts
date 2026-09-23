"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { deleteUploads, uploadImage, uploadLogo } from "@/lib/upload";
import { isHex, resolveSponsors } from "@/lib/sponsors";
import { getTournament } from "@/lib/data";
import type {
  BrandingConfig,
  EventBackground,
  SponsorEntry,
  FormatConfig,
  MatchRules,
  ScoringConfig,
  Stage,
  StageRuleKey,
} from "@/lib/types";
import {
  STAGE_RULE_LABELS,
  scoringConfigForMatch,
  validateMatchRules,
} from "@/lib/scoring/rules";
import { validatePodiumSettings } from "@/lib/bracket";
import { entityRefusal, refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { DEFAULT_DIM, isBackgroundDim } from "@/lib/background";
import {
  acceptBackgroundUpload,
  createBackgroundUpload,
  removeBackgroundIfUnused,
  updateBranding,
  withBackground,
} from "@/lib/backgroundStorage";

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
  // A session's hidden row is renamed with the session, never from here.
  refuse(await tournamentRowRefusal(id));
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
  // A session's match rules are set when it is created; its scoring and the
  // ledger it feeds are not the tournament rules form's to change.
  const refusal = await tournamentRowRefusal(id);
  if (refusal) return { ok: false, problems: [refusal] };
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
      ? { requireResultConfirmation: formData.getAll("requireResultConfirmation").includes("on") }
      : {}),
    // Tennis only: the form carries the doubles block, so an absent block leaves it alone.
    ...(formData.has("doubles.present")
      ? {
          doubles: {
            decidingPoint: formData.get("doubles.decidingPoint") === "on",
            matchTiebreak: formData.get("doubles.matchTiebreak") === "on",
            matchTiebreakPoints: num("doubles.matchTiebreakPoints", 10),
          },
        }
      : {}),
  };

  // Validate what each bucket actually resolves to, not the override in isolation:
  // a trigger is only wrong in combination with the set length it inherits.
  const problems: string[] = [];
  for (const p of validateMatchRules(base)) problems.push(`Tournament default — ${p.message}`);
  if (scoring.doubles) {
    const doublesRules = scoringConfigForMatch({ scoring_config: scoring, sport: t.sport }, { stage: "group" }, null, { doubles: true });
    for (const p of validateMatchRules(doublesRules)) problems.push(`Doubles — ${p.message}`);
  }
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
  // A session's scheduler assigns rounds to its courts. Adding one is shared with
  // sessions; removing one from here is not, and never another tournament's.
  refuse(await entityRefusal(id, "courts", courtId));
  await db().from("courts").delete().eq("id", courtId).eq("tournament_id", id);
  revalidatePath(settingsPath(id));
}

export type BrandingFormState = { ok: true; message: string } | { ok: false; problems: string[] } | null;

const INTENSITIES = ["subtle", "standard", "vivid"] as const;

function text(formData: FormData, key: string, max: number): string {
  return String(formData.get(key) ?? "").trim().slice(0, max);
}

function fileFrom(formData: FormData, key: string): File | null {
  const f = formData.get(key);
  return f instanceof File && f.size > 0 ? f : null;
}

/**
 * Logos, the main sponsor, the footer sponsors and the holding slate.
 *
 * Returns problems instead of throwing, so a bad colour or an oversized logo
 * shows under the form rather than as the default error page. Used from the
 * tournament settings page and from a friendly session's admin page, which edits
 * its backing tournament's branding with the same form.
 */
export async function saveBranding(_prev: BrandingFormState, formData: FormData): Promise<BrandingFormState> {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  const t = await getTournament(id);
  if (!t) return { ok: false, problems: ["Tournament not found."] };
  const branding: BrandingConfig = { ...t.branding_config };
  const problems: string[] = [];

  try {
    const single: [string, "moveBeyondLogoUrl" | "clientLogoUrl" | "eventLogoUrl" | "backgroundUrl"][] = [
      ["move_beyond_logo", "moveBeyondLogoUrl"],
      ["client_logo", "clientLogoUrl"],
      ["event_logo", "eventLogoUrl"],
      ["background", "backgroundUrl"],
    ];
    for (const [field, key] of single) {
      const file = fileFrom(formData, field);
      if (file) branding[key] = await uploadImage(file, `branding/${id}`);
    }

    // ---------- main sponsor ----------
    if (formData.get("main_remove") === "on") {
      delete branding.mainSponsor;
    } else {
      const name = text(formData, "main_name", 60);
      const accent = text(formData, "main_accent", 7);
      const intensityRaw = text(formData, "main_intensity", 10);
      const intensity = (INTENSITIES as readonly string[]).includes(intensityRaw)
        ? (intensityRaw as (typeof INTENSITIES)[number])
        : "standard";
      const logo = fileFrom(formData, "main_logo");
      // Checked before uploading, so a rejected save leaves no orphaned file.
      const uploaded = logo && isHex(accent) ? await uploadLogo(logo, `branding/${id}/main`) : null;
      const logoUrl = uploaded?.url ?? branding.mainSponsor?.logoUrl ?? (logo ? "pending" : "");
      const touched = Boolean(name || logo || branding.mainSponsor);
      if (touched) {
        if (!logoUrl) problems.push("Upload the main sponsor's logo — the glow is the logo.");
        if (!isHex(accent)) problems.push("The main sponsor's colour must be a hex colour like #00a651.");
        if (logoUrl && isHex(accent)) {
          branding.mainSponsor = {
            name,
            logoUrl,
            accentHex: accent.toLowerCase(),
            intensity,
            showOnDashboard: formData.getAll("main_dashboard").includes("on"),
            ...(uploaded ? (uploaded.aspect ? { aspect: uploaded.aspect } : {}) : branding.mainSponsor?.aspect ? { aspect: branding.mainSponsor.aspect } : {}),
          };
        }
      }
    }

    // ---------- footer sponsors ----------
    // The rows posted back are checked against what is stored, so a hand-edited
    // form cannot slip an arbitrary URL onto a public wall.
    const current = resolveSponsors(t.branding_config).footer;
    const byUrl = new Map(current.map((sp) => [sp.logoUrl, sp]));
    const count = Math.min(200, Number(formData.get("sponsor_count") ?? 0) || 0);
    const kept: SponsorEntry[] = [];
    for (let i = 0; i < count; i++) {
      const url = String(formData.get(`sponsor_url_${i}`) ?? "");
      const existing = byUrl.get(url);
      if (!existing || formData.get(`sponsor_remove_${i}`) === "on") continue;
      kept.push({ ...existing, name: text(formData, `sponsor_name_${i}`, 60) });
    }
    const added = formData.getAll("sponsor_logos").filter((f): f is File => f instanceof File && f.size > 0);
    for (const f of added) {
      const up = await uploadLogo(f, `branding/${id}/sponsors`);
      kept.push({ name: "", logoUrl: up.url, ...(up.aspect ? { aspect: up.aspect } : {}) });
    }
    if (formData.get("clear_sponsors") === "on") kept.length = 0;
    branding.sponsors = kept;
    // Kept in step for anything still reading the old list (clones, exports).
    branding.sponsorLogoUrls = kept.map((sp) => sp.logoUrl);

    // ---------- how the band draws its logos ----------
    // Each rides with a hidden "off", so unticking is written too: an unchecked
    // box sends nothing, which would otherwise read as "leave it alone".
    if (formData.has("sponsor_chips")) branding.sponsorChips = formData.getAll("sponsor_chips").includes("on");
    if (formData.has("sponsor_uniform")) {
      branding.sponsorUniformSize = formData.getAll("sponsor_uniform").includes("on");
    }

    // ---------- red and blue teams ----------
    if (formData.has("red_blue_teams")) branding.redBlueTeams = formData.getAll("red_blue_teams").includes("on");

    // ---------- holding slate ----------
    const holdingImage = fileFrom(formData, "holding_image");
    branding.holding = {
      title: text(formData, "holding_title", 120),
      message: text(formData, "holding_message", 200),
      imageUrl:
        formData.get("holding_clear_image") === "on"
          ? ""
          : holdingImage
            ? await uploadImage(holdingImage, `branding/${id}/holding`)
            : (branding.holding?.imageUrl ?? ""),
    };
  } catch (e) {
    problems.push(e instanceof Error ? e.message : "Upload failed.");
  }

  if (problems.length > 0) return { ok: false, problems };

  // ---------- event background ----------
  // The file is uploaded on its own (see finishBackgroundUpload); this form only
  // sets how it is shown, or removes it — and only for the background it was
  // showing. If another upload replaced it meanwhile, that one is left alone.
  const formBackground = String(formData.get("background_url") ?? "");
  const removeBackground = formData.get("background_remove") === "on";
  const dimRaw = text(formData, "background_dim", 10);
  const adjustBackground = (stored: EventBackground | undefined): EventBackground | undefined => {
    if (!stored || !formBackground || stored.url !== formBackground) return stored;
    if (removeBackground) return undefined;
    if (!formData.has("background_dim")) return stored;
    return {
      ...stored,
      dim: isBackgroundDim(dimRaw) ? dimRaw : DEFAULT_DIM,
      showOnPublic: formData.getAll("background_public").includes("on"),
    };
  };

  // Built from the row as it is at the moment of writing: the form's own fields
  // win, but the background is whatever is stored then, adjusted as above.
  const written = await updateBranding(id, (current) => withBackground(branding, adjustBackground(current.background)));
  if (!written.ok) return { ok: false, problems: ["Could not save the branding. Try again."] };
  await audit({ tournament_id: id, actor_role: role, action: "BRANDING_UPDATED" });
  const removed = written.before.background?.url;
  if (removed && removed !== written.after.background?.url) await removeBackgroundIfUnused(removed);
  revalidatePath(settingsPath(id));
  const back = String(formData.get("return_path") ?? "");
  if (back.startsWith("/admin/")) revalidatePath(back);
  return { ok: true, message: "Branding saved." };
}

export type BackgroundTicket = { ok: true; path: string; signedUrl: string } | { ok: false; message: string };

/**
 * Step one of uploading an event background: checks the file's type and size and
 * returns a one-time link the browser uploads it to directly. A GIF or a video
 * loop is far larger than a server action accepts. Shared with sessions, like the
 * rest of the branding.
 */
export async function prepareBackgroundUpload(
  tournamentId: string,
  file: { type: string; size: number },
): Promise<BackgroundTicket> {
  await requirePermission("manage_tournament");
  const t = await getTournament(String(tournamentId));
  if (!t) return { ok: false, message: "Tournament not found." };
  return createBackgroundUpload(t.id, { type: String(file?.type ?? ""), size: Number(file?.size ?? 0) });
}

export type BackgroundResult =
  | { ok: true; message: string; background: EventBackground }
  | { ok: false; message: string };

/**
 * Step two: checks what actually arrived and makes it the event's background,
 * replacing the previous one. Returns a refusal as state, never throws.
 */
export async function finishBackgroundUpload(
  tournamentId: string,
  path: string,
  returnPath?: string,
): Promise<BackgroundResult> {
  const role = await requirePermission("manage_tournament");
  const t = await getTournament(String(tournamentId));
  if (!t) return { ok: false, message: "Tournament not found." };
  const previous = t.branding_config.background;
  const accepted = await acceptBackgroundUpload(t.id, String(path), previous);
  if (!accepted.ok) return accepted;

  // Built from the row as it is at the moment of writing, so a branding save made
  // during a long upload is kept, and the file deleted is the one actually replaced.
  const written = await updateBranding(t.id, (current) => withBackground(current, accepted.background));
  if (!written.ok) {
    await deleteUploads([accepted.background.url]);
    return { ok: false, message: "Could not save the new background. Try again." };
  }
  await audit({ tournament_id: t.id, actor_role: role, action: "BRANDING_UPDATED" });
  const replaced = written.before.background?.url;
  if (replaced && replaced !== accepted.background.url) await removeBackgroundIfUnused(replaced);

  revalidatePath(settingsPath(t.id));
  if (returnPath && String(returnPath).startsWith("/admin/")) revalidatePath(String(returnPath));
  const note =
    accepted.removed.length > 0
      ? ` Removed from the SVG: ${accepted.removed.join(", ")}. Animation made with CSS or SMIL still plays; script-driven animation never runs in a background.`
      : "";
  return { ok: true, message: `Background uploaded — it is on the screens now.${note}`, background: accepted.background };
}
