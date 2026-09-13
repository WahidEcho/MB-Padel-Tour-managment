import { db } from "./supabase";
import { audit, slugify } from "./audit";
import { getScreenSettings } from "./data";
import type { ScreenSettings } from "./types";

/** The default screen. Always exists, cannot be deleted, owns /t/<slug>/screen. */
export const MAIN_SCREEN = "main";

/** Screen keys are URL segments, so they are validated before any lookup. */
export const SCREEN_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;

export function isValidScreenKey(key: string): boolean {
  return SCREEN_KEY_PATTERN.test(key);
}

/** A cap, so a stuck script cannot fill the table for one tournament. */
const MAX_SCREENS = 12;

export interface ScreenResult {
  ok: boolean;
  /** Present on success; the resolved key, which may differ from the name. */
  key?: string;
  message?: string;
}

/**
 * Creates the `main` row for a brand-new tournament.
 *
 * Upserts rather than inserts so two callers racing on the same fresh
 * tournament cannot trip the unique key — which matters because a tournament,
 * its demo seed and a clone all reach this.
 */
export async function ensureMainScreen(tournamentId: string): Promise<void> {
  await db()
    .from("screen_settings")
    .upsert(
      { tournament_id: tournamentId, screen_key: MAIN_SCREEN },
      { onConflict: "tournament_id,screen_key", ignoreDuplicates: true },
    );
}

/**
 * Adds a screen.
 *
 * The key comes from the name and is then fixed forever, because it is the URL
 * a TV is already open on. A clashing name is reported rather than silently
 * suffixed: the operator asked for a specific name, and two screens called the
 * same thing are impossible to tell apart in a control room.
 */
export async function createScreen(
  tournamentId: string,
  name: string,
  actorRole: string,
): Promise<ScreenResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "Give the screen a name." };

  const key = slugify(trimmed);
  // slugify falls back to "tournament" for a name with no latin characters,
  // which would be a meaningless URL.
  if (!isValidScreenKey(key) || (key === "tournament" && !/tournament/i.test(trimmed))) {
    return { ok: false, message: "Use a name with letters or numbers, for example “TV 2” or “Lobby”." };
  }
  if (key === MAIN_SCREEN) {
    return { ok: false, message: "“Main” is the default screen and already exists." };
  }

  const { count } = await db()
    .from("screen_settings")
    .select("id", { count: "exact", head: true })
    .eq("tournament_id", tournamentId);
  if ((count ?? 0) >= MAX_SCREENS) {
    return { ok: false, message: `A tournament can have at most ${MAX_SCREENS} screens.` };
  }

  const { error } = await db()
    .from("screen_settings")
    .insert({ tournament_id: tournamentId, screen_key: key, screen_name: trimmed });
  if (error) {
    // 23505 is the unique violation on (tournament_id, screen_key).
    if (error.code === "23505") {
      return { ok: false, message: `A screen named “${trimmed}” already exists.` };
    }
    return { ok: false, message: error.message };
  }

  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "SCREEN_CREATED",
    entity_type: "screen",
    entity_id: key,
    new_value: { name: trimmed },
  });
  return { ok: true, key };
}

/** Renames a screen. The key, and therefore the URL, never changes. */
export async function renameScreen(
  tournamentId: string,
  screenKey: string,
  name: string,
  actorRole: string,
): Promise<ScreenResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "Give the screen a name." };
  const { error } = await db()
    .from("screen_settings")
    .update({ screen_name: trimmed, updated_at: new Date().toISOString() })
    .eq("tournament_id", tournamentId)
    .eq("screen_key", screenKey);
  if (error) return { ok: false, message: error.message };
  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "SCREEN_RENAMED",
    entity_type: "screen",
    entity_id: screenKey,
    new_value: { name: trimmed },
  });
  return { ok: true, key: screenKey };
}

/** Deletes a screen. `main` is refused: it is the default screen's URL. */
export async function deleteScreen(
  tournamentId: string,
  screenKey: string,
  actorRole: string,
): Promise<ScreenResult> {
  if (screenKey === MAIN_SCREEN) {
    return { ok: false, message: "The main screen cannot be deleted." };
  }
  const { error } = await db()
    .from("screen_settings")
    .delete()
    .eq("tournament_id", tournamentId)
    .eq("screen_key", screenKey);
  if (error) return { ok: false, message: error.message };
  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "SCREEN_DELETED",
    entity_type: "screen",
    entity_id: screenKey,
  });
  return { ok: true, key: screenKey };
}

export type ScreenPatch = Partial<
  Pick<
    ScreenSettings,
    | "display_mode"
    | "court_ids"
    | "focus_court_id"
    | "focus_match_id"
    | "bracket_tier"
    | "theme"
    | "sponsor_rotation_seconds"
    | "mute_animations"
    | "break_started_at"
    | "break_ends_at"
    | "ceremony_step"
    | "ceremony_step_at"
    | "entrance_replay"
  >
>;

export type WriteResult =
  | { ok: true; revision: number }
  | { ok: false; conflict: true; current: ScreenSettings }
  | { ok: false; conflict?: false; message: string };

/**
 * Writes one screen, refusing to overwrite a change made since it was read.
 *
 * Compare-and-swap on `revision`, the same discipline the match events endpoint
 * already uses for two referees on two tablets. With a laptop at the desk and a
 * tablet on court this is not optional: without it, the last save silently wins
 * and the other operator's change vanishes with no sign that it happened.
 */
export async function updateScreen(
  tournamentId: string,
  screenKey: string,
  expectedRevision: number,
  patch: ScreenPatch,
  actorRole: string,
): Promise<WriteResult> {
  const { data, error } = await db()
    .from("screen_settings")
    .update({ ...patch, revision: expectedRevision + 1, updated_at: new Date().toISOString() })
    .eq("tournament_id", tournamentId)
    .eq("screen_key", screenKey)
    .eq("revision", expectedRevision)
    .select()
    .maybeSingle();

  if (error) return { ok: false, message: error.message };

  if (!data) {
    // No row matched: either somebody else wrote first, or the screen is gone.
    const current = await getScreenSettings(tournamentId, screenKey);
    if (!current) return { ok: false, message: "That screen has been deleted." };
    return { ok: false, conflict: true, current };
  }

  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "SCREEN_SETTINGS_CHANGED",
    entity_type: "screen",
    entity_id: screenKey,
    new_value: patch as Record<string, unknown>,
  });
  return { ok: true, revision: (data as ScreenSettings).revision };
}

export interface ApplyOutcome {
  updated: string[];
  /** Screens that changed under us, by name. */
  conflicted: string[];
  /** Screens a patch could not apply to, with the reason. */
  skipped: { screen: string; reason: string }[];
}

/**
 * Decides what a push-to-many actually writes, per screen.
 *
 * Two rules make this safe, and both exist because the obvious implementation
 * breaks the feature it is for:
 *
 *  - Coverage is never written here. One click setting the same `court_ids`
 *    everywhere would destroy the court split that having several screens
 *    exists for; coverage is edited on the screen itself.
 *  - A pin is checked against each screen's own coverage. Pinning the lobby
 *    wall to court 4 is meaningful; pinning a court 1-3 screen to court 4 is
 *    not, so it is skipped and reported rather than quietly stored.
 */
export function planApplyToScreens(
  patch: ScreenPatch,
  screens: ScreenSettings[],
  courtIdsExist: (courtId: string) => boolean,
): { screen: ScreenSettings; patch: ScreenPatch }[] {
  const shared: ScreenPatch = { ...patch };
  delete shared.court_ids;

  return screens.flatMap((screen) => {
    const own: ScreenPatch = { ...shared };
    const pin = shared.focus_court_id;
    if (pin) {
      const covered = !screen.court_ids?.length || screen.court_ids.includes(pin);
      if (!covered || !courtIdsExist(pin)) return [];
    }
    return [{ screen, patch: own }];
  });
}
