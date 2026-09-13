"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { getBrackets, getCourts, getScreenSettings, listScreens } from "@/lib/data";
import {
  createScreen,
  deleteScreen,
  planApplyToScreens,
  renameScreen,
  updateScreen,
  type ScreenPatch,
} from "@/lib/screens";
import type { DisplayMode, ScreenSettings } from "@/lib/types";
import { modeChangeEffects, parseScreenCommand } from "@/lib/tv/commands";
import { applyCommandToScreens, applyScreenCommand } from "@/lib/tv/commandsServer";

export type ScreenFormState =
  | { ok: true; message: string }
  | { ok: false; message: string }
  /** Somebody else changed this screen since the form was rendered. */
  | { ok: false; conflict: true; message: string }
  | null;

function paths(tournamentId: string, screenKey?: string) {
  return [
    `/operator/tournaments/${tournamentId}/control`,
    ...(screenKey ? [`/operator/tournaments/${tournamentId}/control/${screenKey}`] : []),
    `/admin/tournaments/${tournamentId}/screens`,
  ];
}

/**
 * Every screen write revalidates all three surfaces that show screen state.
 * Without this, a change made on a screen's own page is invisible in the
 * control room until its own refresh fires, which reads as "my change was lost".
 */
function revalidateAll(tournamentId: string, screenKey?: string) {
  for (const p of paths(tournamentId, screenKey)) revalidatePath(p);
}

/** Whether a ceremony put on air should honour the Plate before the Cup. */
async function plateBracketPublished(tournamentId: string): Promise<boolean> {
  return (await getBrackets(tournamentId)).some((b) => b.tier === "plate" && b.status === "published");
}

/** Reads the patch a form is asking for. Absent fields are left untouched. */
function patchFrom(formData: FormData, courts: { id: string }[]): ScreenPatch {
  const patch: ScreenPatch = {};

  const mode = formData.get("display_mode");
  if (mode) patch.display_mode = String(mode) as DisplayMode;

  const theme = formData.get("theme");
  if (theme) patch.theme = String(theme) === "light" ? "light" : "dark";

  const rotation = formData.get("sponsor_rotation_seconds");
  if (rotation) patch.sponsor_rotation_seconds = Math.max(3, parseInt(String(rotation), 10) || 10);

  const tier = formData.get("bracket_tier");
  if (tier) patch.bracket_tier = String(tier) as ScreenSettings["bracket_tier"];

  if (formData.has("focus_court_id")) {
    const value = String(formData.get("focus_court_id") ?? "");
    // Pinning to a court that no longer exists would strand the screen, so an
    // unknown id reads as "follow live".
    patch.focus_court_id = courts.some((c) => c.id === value) ? value : null;
    // The two pins are one state: setting a court clears any match pin.
    patch.focus_match_id = null;
  }

  if (formData.has("court_ids")) {
    const wanted = formData.getAll("court_ids").map(String);
    patch.court_ids = courts.filter((c) => wanted.includes(c.id)).map((c) => c.id);
  }

  return patch;
}

/** Saves one screen, refusing to overwrite a change made since it was read. */
export async function saveScreen(_prev: ScreenFormState, formData: FormData): Promise<ScreenFormState> {
  const role = await requirePermission("control_screen");
  const tournamentId = String(formData.get("tournament_id"));
  const screenKey = String(formData.get("screen_key") || "main");
  const expected = parseInt(String(formData.get("revision") ?? "0"), 10) || 0;

  const [courts, current] = await Promise.all([getCourts(tournamentId), getScreenSettings(tournamentId, screenKey)]);
  const asked = patchFrom(formData, courts);
  if (Object.keys(asked).length === 0) return { ok: false, message: "Nothing to change." };
  const patch = current
    ? modeChangeEffects(asked, current, Date.now(), { plateBracketPublished: await plateBracketPublished(tournamentId) })
    : asked;

  const result = await updateScreen(tournamentId, screenKey, expected, patch, role);
  revalidateAll(tournamentId, screenKey);

  if (result.ok) return { ok: true, message: "On air." };
  if (result.conflict) {
    return {
      ok: false,
      conflict: true,
      message: "Someone else changed this screen. It has been reloaded — check it and try again.",
    };
  }
  return { ok: false, message: result.message };
}

/**
 * Pushes one change to several screens at once.
 *
 * Coverage is deliberately not pushable: one click writing the same courts
 * everywhere would destroy the court split that having several screens is for.
 */
export async function applyToScreens(_prev: ScreenFormState, formData: FormData): Promise<ScreenFormState> {
  const role = await requirePermission("control_screen");
  const tournamentId = String(formData.get("tournament_id"));
  const selected = formData.getAll("screen_key").map(String);

  const [courts, screens] = await Promise.all([getCourts(tournamentId), listScreens(tournamentId)]);
  const targets = selected.length > 0 ? screens.filter((s) => selected.includes(s.screen_key)) : screens;
  if (targets.length === 0) return { ok: false, message: "Pick at least one screen." };

  const patch = patchFrom(formData, courts);
  delete patch.court_ids;
  if (Object.keys(patch).length === 0) return { ok: false, message: "Nothing to change." };

  const courtExists = (courtId: string) => courts.some((c) => c.id === courtId);
  const plan = planApplyToScreens(patch, targets, courtExists);
  const skipped = targets.filter((t) => !plan.some((p) => p.screen.id === t.id));

  const updated: string[] = [];
  const conflicted: string[] = [];
  const nowMs = Date.now();
  const plate = await plateBracketPublished(tournamentId);
  for (const { screen, patch: own } of plan) {
    const result = await updateScreen(
      tournamentId,
      screen.screen_key,
      screen.revision,
      modeChangeEffects(own, screen, nowMs, { plateBracketPublished: plate }),
      role,
    );
    if (result.ok) updated.push(screen.screen_name ?? screen.screen_key);
    else if ("conflict" in result && result.conflict) conflicted.push(screen.screen_name ?? screen.screen_key);
  }
  revalidateAll(tournamentId);

  const parts = [`${updated.length} of ${targets.length} updated`];
  if (conflicted.length > 0) parts.push(`${conflicted.join(", ")} was changed by someone else`);
  if (skipped.length > 0) {
    parts.push(
      `${skipped.map((s) => s.screen_name ?? s.screen_key).join(", ")} skipped — that court is not on ${skipped.length === 1 ? "it" : "them"}`,
    );
  }
  const message = parts.join(" · ");
  return conflicted.length === 0 ? { ok: true, message } : { ok: false, message };
}

export async function addScreen(_prev: ScreenFormState, formData: FormData): Promise<ScreenFormState> {
  const role = await requirePermission("manage_screens");
  const tournamentId = String(formData.get("tournament_id"));
  const result = await createScreen(tournamentId, String(formData.get("screen_name") ?? ""), role);
  revalidateAll(tournamentId, result.key);
  return result.ok
    ? { ok: true, message: `Added. Its link is /t/…/screen/${result.key}` }
    : { ok: false, message: result.message ?? "Could not add that screen." };
}

export async function renameScreenAction(_prev: ScreenFormState, formData: FormData): Promise<ScreenFormState> {
  const role = await requirePermission("manage_screens");
  const tournamentId = String(formData.get("tournament_id"));
  const screenKey = String(formData.get("screen_key"));
  const result = await renameScreen(tournamentId, screenKey, String(formData.get("screen_name") ?? ""), role);
  revalidateAll(tournamentId, screenKey);
  return result.ok
    ? { ok: true, message: "Renamed. The link is unchanged." }
    : { ok: false, message: result.message ?? "Could not rename that screen." };
}

export async function removeScreen(formData: FormData) {
  const role = await requirePermission("delete_screen");
  const tournamentId = String(formData.get("tournament_id"));
  const screenKey = String(formData.get("screen_key"));
  const result = await deleteScreen(tournamentId, screenKey, role);
  if (!result.ok) throw new Error(result.message ?? "Could not delete that screen.");
  revalidateAll(tournamentId);
}

/** One live control — mute, break, replay entrance, a ceremony move — on one screen. */
export async function screenCommand(_prev: ScreenFormState, formData: FormData): Promise<ScreenFormState> {
  const role = await requirePermission("control_screen");
  const tournamentId = String(formData.get("tournament_id"));
  const screenKey = String(formData.get("screen_key") || "main");
  const expected = parseInt(String(formData.get("revision") ?? "0"), 10) || 0;
  const command = parseScreenCommand((name) => (formData.has(name) ? String(formData.get(name)) : null));
  if (!command) return { ok: false, message: "That control is not recognised." };

  const result = await applyScreenCommand(tournamentId, screenKey, expected, command, role);
  revalidateAll(tournamentId, screenKey);
  if (result.ok) return { ok: true, message: "On air." };
  if ("conflict" in result && result.conflict) {
    return {
      ok: false,
      conflict: true,
      message: "Someone else changed this screen a moment ago. It has been reloaded — check it and press again.",
    };
  }
  return { ok: false, message: result.message };
}

/** One live control pushed to the selected screens, or to every screen. */
export async function commandToScreens(_prev: ScreenFormState, formData: FormData): Promise<ScreenFormState> {
  const role = await requirePermission("control_screen");
  const tournamentId = String(formData.get("tournament_id"));
  const command = parseScreenCommand((name) => (formData.has(name) ? String(formData.get(name)) : null));
  if (!command) return { ok: false, message: "That control is not recognised." };

  // The ceremony step each wall showed in the control room, as `expect_step:<key>`.
  const expectedSteps = new Map<string, number>();
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith("expect_step:")) continue;
    const step = Number(value);
    if (Number.isInteger(step)) expectedSteps.set(name.slice("expect_step:".length), step);
  }
  const out = await applyCommandToScreens(tournamentId, formData.getAll("screen_key").map(String), command, role, {
    expectedSteps,
  });
  revalidateAll(tournamentId);
  if (out.targets === 0) return { ok: false, message: "Pick at least one screen." };
  const parts = [`${out.updated.length} of ${out.targets} updated`];
  if (out.conflicted.length > 0) parts.push(`${out.conflicted.join(", ")} was changed by someone else`);
  if (out.skipped.length > 0) parts.push(out.skipped.map((s) => `${s.screen} skipped — ${s.reason}`).join(", "));
  const message = parts.join(" · ");
  return out.conflicted.length === 0 && out.updated.length > 0 ? { ok: true, message } : { ok: false, message };
}

/** Used by the per-screen page to reload after a conflict. */
export async function currentScreen(tournamentId: string, screenKey: string) {
  await requirePermission("control_screen");
  return getScreenSettings(tournamentId, screenKey);
}
