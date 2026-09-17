"use client";

import { useActionState } from "react";
import { MANUAL_STATUSES } from "@/lib/standings";
import { overrideQualification, type OverrideState } from "./actions";

/**
 * The status override on one team's row.
 *
 * A client form rather than a plain one so a refusal is shown beside the team it
 * concerns. It used to throw, which replaced the whole page with an error screen
 * and lost whatever else the organiser was in the middle of.
 *
 * The select is keyed by the stored status, so after a save it shows what the
 * server actually wrote. Without the key React keeps the browser's own value on
 * an uncontrolled select, and a failed save would go on showing the status the
 * organiser picked as though it had been applied.
 */
export default function QualificationControl({
  tournamentId,
  teamId,
  groupId,
  status,
  overridden,
}: {
  tournamentId: string;
  teamId: string;
  groupId: string;
  status: string;
  overridden: boolean;
}) {
  const [state, action, pending] = useActionState<OverrideState, FormData>(overrideQualification, null);

  return (
    <form action={action} className="flex items-center gap-1">
      <input type="hidden" name="tournament_id" value={tournamentId} />
      <input type="hidden" name="team_id" value={teamId} />
      <input type="hidden" name="group_id" value={groupId} />
      <select
        key={status}
        name="status"
        defaultValue={status}
        className="input w-auto px-2 py-1 text-xs"
        disabled={pending}
        aria-label="Qualification status"
      >
        {MANUAL_STATUSES.map((st) => (
          <option key={st} value={st}>
            {st}
          </option>
        ))}
      </select>
      <button className="btn-secondary px-2 py-1 text-xs" disabled={pending} data-testid="override-set">
        {pending ? "…" : "Set"}
      </button>
      {overridden && (
        <button
          name="reset"
          value="1"
          className="px-1 text-xs text-muted hover:text-foreground"
          title="Clear override"
          disabled={pending}
          data-testid="override-clear"
        >
          ↺
        </button>
      )}
      {state && !state.ok && (
        <span className="text-xs text-danger" role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}
