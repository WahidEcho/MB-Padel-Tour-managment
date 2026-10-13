"use client";

import { useActionState } from "react";
import { createEventCode, type CodeFormState } from "./actions";

export default function CodeForm({ tournaments }: { tournaments: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<CodeFormState, FormData>(createEventCode, null);
  return (
    <form action={action} className="card grid gap-3 sm:grid-cols-2">
      <div>
        <label className="label" htmlFor="code-role">For</label>
        <select id="code-role" name="role" className="input" defaultValue="referee">
          <option value="referee">Referee</option>
          <option value="operator">Screen operator</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="code-scope">Only for</label>
        <select id="code-scope" name="tournament_id" className="input" defaultValue="">
          <option value="">Every event of the organisation</option>
          {tournaments.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="code-label">Label</label>
        <input id="code-label" name="label" className="input" placeholder="e.g. Court 3 referee" maxLength={80} />
      </div>
      <div>
        <label className="label" htmlFor="code-days">Expires after (days)</label>
        <input id="code-days" name="expires_days" type="number" min={1} max={365} className="input" placeholder="never" />
      </div>
      <div className="sm:col-span-2">
        <button className="btn-primary" disabled={pending}>{pending ? "Creating…" : "Create code"}</button>
      </div>
      {state?.ok === false && <p className="text-sm text-danger sm:col-span-2">{state.message}</p>}
      {state?.ok && (
        <div className="rounded-xl border border-success/40 bg-success/10 p-3 sm:col-span-2" data-testid="new-code">
          <p className="text-xs text-muted">Shown once. Copy it now: only its fingerprint is kept.</p>
          <p className="mt-1 font-mono text-2xl font-bold tracking-widest">{state.code}</p>
          <p className="text-xs text-muted capitalize">{state.role}{state.label ? ` · ${state.label}` : ""}</p>
        </div>
      )}
    </form>
  );
}
