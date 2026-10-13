"use client";

import { useActionState, useState } from "react";
import { createEventCode, type CodeFormState } from "./actions";

export default function CodeForm({ tournaments }: { tournaments: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<CodeFormState, FormData>(createEventCode, null);
  const [copied, setCopied] = useState<string | null>(null);
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
        <label className="label" htmlFor="code-days">Expires</label>
        <select id="code-days" name="expires_days" className="input" defaultValue="3">
          <option value="1">After 1 day</option>
          <option value="3">After 3 days</option>
          <option value="7">After a week</option>
          <option value="30">After 30 days</option>
          <option value="90">After 90 days</option>
          <option value="">Never (revoke it by hand)</option>
        </select>
      </div>
      <div className="sm:col-span-2">
        <button className="btn-primary" disabled={pending}>{pending ? "Creating…" : "Create code"}</button>
      </div>
      {state?.ok === false && <p className="text-sm text-danger sm:col-span-2">{state.message}</p>}
      {state?.ok && (
        <div className="rounded-xl border border-success/40 bg-success/10 p-3 sm:col-span-2" data-testid="new-code">
          <p className="text-xs text-muted">Shown once. Copy it now: only its fingerprint is kept.</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <p className="font-mono text-2xl font-bold tracking-widest">{state.code}</p>
            <button type="button" className="btn-secondary text-xs" onClick={() => void navigator.clipboard?.writeText(state.code).then(() => setCopied(state.code))}>
              {copied === state.code ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-muted">
            <span className="capitalize">{state.role === "operator" ? "screen operator" : state.role}</span>
            {state.label ? ` · ${state.label}` : ""}
            {` · ${state.scope ?? "every event"}`}
            {` · ${state.expiresAt ? `expires ${state.expiresAt}` : "never expires"}`}
          </p>
        </div>
      )}
    </form>
  );
}
