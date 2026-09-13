import { revalidatePath } from "next/cache";
import { decodeBracketFingerprint, type BracketFingerprint, type BracketSummary } from "@/lib/bracket";
import { regenerateGroupStage } from "@/lib/ops";

/**
 * What the regenerate forms show after a submit.
 *
 * Returned, never thrown: a thrown server-action message is replaced by a generic
 * one in production, so a refusal the organiser has to act on must travel back
 * as data.
 */
export type GroupStageFormState =
  | { ok: true; message: string }
  | {
      ok: false;
      reason: "brackets_exist" | "brackets_changed" | "not_a_tournament" | "error";
      message: string;
      brackets?: BracketSummary[];
    }
  | null;

/** Shared by the Matches page's Regenerate and the Groups page's Publish. */
export async function runGroupStageRegeneration(
  tournamentId: string,
  actorRole: string,
  formData: FormData,
  opts: { publishGroups?: boolean } = {},
): Promise<GroupStageFormState> {
  // Present only on the second, explicitly confirmed submit: one fingerprint per
  // bracket the organiser was shown, so a bracket published or played since
  // cannot be deleted on a confirmation that described it as untouched.
  const confirmBrackets = formData
    .getAll("confirm_bracket")
    .map((v) => decodeBracketFingerprint(String(v)))
    .filter((b): b is BracketFingerprint => b !== null);

  let result;
  try {
    result = await regenerateGroupStage(tournamentId, actorRole, {
      confirmBrackets: confirmBrackets.length > 0 ? confirmBrackets : null,
      publishGroups: opts.publishGroups,
    });
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : "Could not regenerate the group stage." };
  } finally {
    // Every outcome, a failure part-way through included, re-renders the pages
    // that show the group stage and the brackets, so none keeps a stale picture.
    const base = `/admin/tournaments/${tournamentId}`;
    for (const p of ["", "/groups", "/matches", "/bracket", "/leaderboard"]) revalidatePath(`${base}${p}`);
  }

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      message: result.message,
      ...("brackets" in result ? { brackets: result.brackets } : {}),
    };
  }
  const deleted =
    result.bracketsDeleted > 0
      ? ` Deleted ${result.bracketsDeleted === 1 ? "the bracket" : `${result.bracketsDeleted} brackets`} and ${result.knockoutMatchesDeleted} knockout match${result.knockoutMatchesDeleted === 1 ? "" : "es"}.`
      : "";
  return {
    ok: true,
    message: `Generated ${result.matchesCreated} group matches.${deleted} Standings were recalculated.`,
  };
}

