"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  bracketsPhrase,
  describeBracket,
  encodeBracketFingerprint,
  groupStageLockedMessage,
  type BracketSummary,
} from "@/lib/bracket";
import type { GroupStageFormState } from "./groupStage";

/**
 * Regenerate the group stage — or, while a knockout is drawn, explain why not.
 *
 * Used by the Matches page (Regenerate group matches) and the Groups page
 * (Publish). With no bracket it is one confirmed button. With one, the plain
 * button is replaced by the reason and a second, separately confirmed form that
 * names each bracket and what deleting it takes; that form posts a fingerprint of
 * every bracket it showed, so the server refuses if any was drawn, reset,
 * published or played in the meantime.
 */
export default function GroupStageRegenerateForm({
  tournamentId,
  action,
  brackets: initialBrackets,
  label,
  confirmMessage,
  blockedReason = null,
  primary = false,
}: {
  tournamentId: string;
  action: (prev: GroupStageFormState, formData: FormData) => Promise<GroupStageFormState>;
  /**
   * The brackets as the page rendered them. Always read from props: every submit
   * revalidates the page, so a refusal or a success arrives with a fresh list.
   */
  brackets: BracketSummary[];
  label: string;
  confirmMessage: string;
  /** Why the button cannot be used right now (an unsaved draw), shown instead of submitting. */
  blockedReason?: string | null;
  primary?: boolean;
}) {
  const [state, formAction, pending] = useActionState<GroupStageFormState, FormData>(action, null);
  const brackets = initialBrackets;

  const guard = (message: string) => (e: React.FormEvent<HTMLFormElement>) => {
    if (blockedReason) {
      e.preventDefault();
      window.alert(blockedReason);
      return;
    }
    if (!window.confirm(message)) e.preventDefault();
  };

  const feedback = state && (
    <p
      role={state.ok ? "status" : "alert"}
      className={`text-sm ${state.ok ? "font-semibold text-success" : state.reason === "brackets_exist" ? "text-warning" : "text-danger"}`}
    >
      {state.message}
    </p>
  );

  if (brackets.length === 0) {
    return (
      <div className="space-y-2">
        <form action={formAction} onSubmit={guard(confirmMessage)}>
          <input type="hidden" name="tournament_id" value={tournamentId} />
          <button className={primary ? "btn-primary" : "btn-secondary"} disabled={pending}>
            {pending ? "Working…" : label}
          </button>
        </form>
        {feedback}
      </div>
    );
  }

  const subject = bracketsPhrase(brackets);
  const played = brackets.reduce((n, b) => n + b.played, 0);
  const knockout = brackets.reduce((n, b) => n + b.matches, 0);
  const destructive =
    `Delete ${subject} and regenerate the whole group stage?\n\n` +
    brackets.map((b) => `• ${describeBracket(b)}`).join("\n") +
    `\n\nThis deletes ${knockout} knockout match${knockout === 1 ? "" : "es"}` +
    (played > 0 ? ` (${played} already played)` : "") +
    ", every group match and its score, and recalculates the standings from scratch. It cannot be undone.";

  return (
    <div className="max-w-xl space-y-2 rounded-xl border border-warning/50 bg-warning/5 p-3" data-testid="group-stage-locked">
      <p className="text-sm font-semibold">
        {state && !state.ok && state.reason === "brackets_changed" ? state.message : groupStageLockedMessage(brackets)}
      </p>
      <ul className="list-inside list-disc text-xs text-muted">
        {brackets.map((b) => (
          <li key={b.id}>{describeBracket(b)}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/admin/tournaments/${tournamentId}/bracket`} className="btn-secondary text-xs">
          Go to the Bracket page
        </Link>
        <form action={formAction} onSubmit={guard(destructive)}>
          <input type="hidden" name="tournament_id" value={tournamentId} />
          {brackets.map((b) => (
            <input key={b.id} type="hidden" name="confirm_bracket" value={encodeBracketFingerprint(b)} />
          ))}
          <button className="btn-danger text-xs" disabled={pending}>
            {pending ? "Working…" : `Delete ${subject} and regenerate`}
          </button>
        </form>
      </div>
      {state && !state.ok && state.reason !== "brackets_exist" && state.reason !== "brackets_changed" && feedback}
    </div>
  );
}
