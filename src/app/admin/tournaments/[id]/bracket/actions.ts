"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { approveBracket, publishBracket, redrawBracket, resetBracketTier, type BracketOpResult } from "@/lib/ops";
import { getBracket, getBrackets, getBracketSlots } from "@/lib/data";
import type { BracketTier } from "@/lib/types";
import { bracketStamp, decodeBracketFingerprint, type CourtStrategy } from "@/lib/bracket";
import { NOT_A_TOURNAMENT_MESSAGE, ownershipRefusal, refuse, tournamentRowRefusal } from "@/lib/rowGuards";

/**
 * What a Bracket page form shows after a submit. Returned, never thrown: a thrown
 * server-action message is replaced by a generic one in production, and these
 * refusals are ones the organiser has to read.
 */
export type BracketFormState =
  | ((BracketOpResult | { ok: false; reason: "error"; message: string }) & {
      /** The bracket state this message was produced under; see bracketStamp. */
      stamp: string;
    })
  | null;

/** Which tier a form is acting on. Defaults to the Cup, the only tier most
 *  tournaments have. */
function tierFrom(formData: FormData): BracketTier {
  return String(formData.get("tier") ?? "cup") === "plate" ? "plate" : "cup";
}

function path(id: string) {
  return `/admin/tournaments/${id}/bracket`;
}

/** The fingerprint a Redraw or Reset confirmation posts: what the organiser was shown. */
function confirmationFrom(formData: FormData) {
  const raw = formData.get("confirm_bracket");
  return raw ? decodeBracketFingerprint(String(raw)) : null;
}

/**
 * Runs one bracket operation as form state, re-rendering the pages it affects
 * whatever happens, and stamps the result with the bracket state it left behind.
 */
async function asFormState(
  id: string,
  scope: BracketTier | "all",
  run: () => Promise<BracketOpResult>,
): Promise<BracketFormState> {
  let result: BracketOpResult | { ok: false; reason: "error"; message: string };
  try {
    result = await run();
  } catch (e) {
    result = { ok: false, reason: "error", message: e instanceof Error ? e.message : "Something went wrong." };
  } finally {
    revalidatePath(path(id));
    revalidatePath(`/admin/tournaments/${id}/matches`);
  }
  return { ...result, stamp: bracketStamp(await getBrackets(id), scope) };
}

/** Draw, or Redraw, one tier. Played matches go only on a matching confirmation. */
export async function generateAction(_prev: BracketFormState, formData: FormData): Promise<BracketFormState> {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const tier = tierFrom(formData);
  return asFormState(id, tier, () => redrawBracket(id, role, tier, { confirm: confirmationFrom(formData) }));
}

/** Edit who-faces-who before publishing: reassign first-round slot teams. */
export async function saveSlots(formData: FormData) {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const bracket = await getBracket(id, tierFrom(formData));
  if (!bracket || bracket.status === "published") throw new Error("Bracket not editable");

  const slots = await getBracketSlots(bracket.id);
  const updates: { slotId: string; teamId: string | null; isBye: boolean }[] = [];
  const seen = new Set<string>();
  for (const slot of slots) {
    const raw = formData.get(`slot_${slot.id}`);
    if (raw === null) continue;
    const value = String(raw);
    if (value === "__bye__") {
      updates.push({ slotId: slot.id, teamId: null, isBye: true });
    } else if (value === "") {
      updates.push({ slotId: slot.id, teamId: null, isBye: false });
    } else {
      if (seen.has(value)) throw new Error("A team is placed in two slots");
      seen.add(value);
      updates.push({ slotId: slot.id, teamId: value, isBye: false });
    }
  }
  // The slots come from this bracket; the teams placed in them are posted, so they
  // must be checked to be this tournament's.
  const placed = updates.map((u) => u.teamId).filter((t): t is string => Boolean(t));
  if (placed.length > 0) refuse(await ownershipRefusal(id, "teams", placed));
  for (const u of updates) {
    await db()
      .from("bracket_slots")
      .update({ team_id: u.teamId, is_bye: u.isBye, source_type: "manual" })
      .eq("id", u.slotId);
  }
  await audit({ tournament_id: id, actor_role: role, action: "BRACKET_EDITED", entity_type: "bracket", entity_id: bracket.id });
  revalidatePath(path(id));
}

export async function approveAction(_prev: BracketFormState, formData: FormData): Promise<BracketFormState> {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const tier = tierFrom(formData);
  return asFormState(id, tier, () => approveBracket(id, role, tier));
}

/**
 * Publishes every drawn tier at once.
 *
 * Not per tier, because the court strategy cannot be honoured one bracket at a
 * time: whichever went first would already hold every court and every low order
 * number, so "both at once" would quietly become "one after another".
 */
export async function publishAction(_prev: BracketFormState, formData: FormData): Promise<BracketFormState> {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const strategy = (String(formData.get("court_strategy") ?? "parallel") === "sequential"
    ? "sequential"
    : "parallel") as CourtStrategy;
  return asFormState(id, "all", async () => {
    // publishBracket itself is shared with the session code, which publishes a
    // session's knockout; publishing from this page is tournament-only.
    const refusal = await tournamentRowRefusal(id);
    if (refusal) {
      return { ok: false, reason: refusal === NOT_A_TOURNAMENT_MESSAGE ? "not_a_tournament" : "not_found", message: refusal };
    }
    await publishBracket(id, role, { courtStrategy: strategy });
    return { ok: true, message: "Published. The knockout matches are on the Matches page." };
  });
}

/**
 * Deletes one tier and only its matches.
 *
 * It used to delete every match in the tournament that was not a group match,
 * which with two brackets would take the other tier's live draw with it. Played
 * matches go only on a confirmation naming them.
 */
export async function resetBracket(_prev: BracketFormState, formData: FormData): Promise<BracketFormState> {
  const role = await requirePermission("edit_bracket");
  const id = String(formData.get("tournament_id"));
  const tier = tierFrom(formData);
  return asFormState(id, tier, () => resetBracketTier(id, role, tier, { confirm: confirmationFrom(formData) }));
}

/** Every tier a tournament has drawn, for the page to render one section each. */
export async function listBrackets(tournamentId: string) {
  await requirePermission("edit_bracket");
  return getBrackets(tournamentId);
}
