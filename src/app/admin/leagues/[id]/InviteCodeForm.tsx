"use client";

import { useActionState, useState } from "react";
import { setInviteCodeAction, type InviteCodeState } from "../actions";

/** Sets a new invite code and shows it once: only its fingerprint is stored. */
export default function InviteCodeForm({ leagueId, hasCode }: { leagueId: string; hasCode: boolean }) {
  const [state, action, pending] = useActionState<InviteCodeState, FormData>(setInviteCodeAction, null);
  const [copied, setCopied] = useState(false);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="league_id" value={leagueId} />
      <button className="btn-secondary" disabled={pending}>{pending ? "Making…" : hasCode ? "Replace the invite code" : "Make an invite code"}</button>
      {state?.ok === false && <p className="text-sm text-danger">{state.message}</p>}
      {state?.ok && (
        <div className="rounded-xl border border-success/40 bg-success/10 p-3" data-testid="new-invite-code">
          <p className="text-xs text-muted">Shown once. Copy it now: only its fingerprint is kept. The old code stops working.</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <p className="font-mono text-2xl font-bold tracking-widest">{state.code}</p>
            <button type="button" className="btn-secondary text-xs" onClick={() => void navigator.clipboard?.writeText(state.code).then(() => setCopied(true))}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
