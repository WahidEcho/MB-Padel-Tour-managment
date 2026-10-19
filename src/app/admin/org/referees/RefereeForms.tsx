"use client";

import { useActionState, useState } from "react";
import { createMasterCodeAction, createRefereeAction, resetRefereePinAction, type RefereeFormState } from "./actions";

function ShownOnce({ state }: { state: RefereeFormState }) {
  const [copied, setCopied] = useState(false);
  if (!state) return null;
  if (!state.ok) return <p className="text-sm text-danger" role="alert">{state.message}</p>;
  const secret = state.code ?? state.pin;
  return (
    <div className="rounded-xl border border-success/40 bg-success/10 p-3" data-testid={state.code ? "new-master-code" : "new-pin"}>
      <p className="text-xs text-muted">Shown once. Give it to {state.name} now: only its fingerprint is kept.</p>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <p className="font-mono text-2xl font-bold tracking-widest" data-testid={state.code ? "master-code-value" : "pin-value"}>{secret}</p>
        <button type="button" className="btn-secondary text-xs" onClick={() => void navigator.clipboard?.writeText(secret).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-xs text-muted">
        {state.code
          ? `${state.name}'s master referee code · ${state.scope ?? "every open event"} · ${state.expiresAt ? `expires ${state.expiresAt}` : "never expires"}. With their own PIN it signs them in to every court.`
          : `${state.name}'s PIN (${state.role === "master_referee" ? "master referee" : "referee"}). With any court's code it signs them in to that court.`}
      </p>
    </div>
  );
}

export function NewRefereeForm({ groups }: { groups: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<RefereeFormState, FormData>(createRefereeAction, null);
  return (
    <form action={action} className="card grid gap-3 sm:grid-cols-2" data-testid="new-referee-form">
      <div>
        <label className="label" htmlFor="ref-name">Name</label>
        <input id="ref-name" name="name" required maxLength={80} className="input" placeholder="e.g. Sara Adel" />
      </div>
      <div>
        <label className="label" htmlFor="ref-phone">Phone</label>
        <input id="ref-phone" name="phone" maxLength={32} className="input" placeholder="+20 10 0000 0000" inputMode="tel" />
      </div>
      <div>
        <label className="label" htmlFor="ref-role">Role</label>
        <select id="ref-role" name="role" className="input" defaultValue="referee">
          <option value="referee">Referee (any court, with the court&apos;s code)</option>
          <option value="master_referee">Master referee (every court)</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="ref-group">Works</label>
        <select id="ref-group" name="event_group_id" className="input" defaultValue="">
          <option value="">Every event of the organisation</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name} only</option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="ref-photo">Photo link (optional)</label>
        <input id="ref-photo" name="photo_url" maxLength={500} className="input" placeholder="https://…" />
      </div>
      <div className="sm:col-span-2">
        <button className="btn-primary" disabled={pending}>{pending ? "Adding…" : "Add referee and make a PIN"}</button>
      </div>
      <div className="sm:col-span-2"><ShownOnce state={state} /></div>
    </form>
  );
}

export function ResetPinForm({ refereeId, name }: { refereeId: string; name: string }) {
  const [state, action, pending] = useActionState<RefereeFormState, FormData>(resetRefereePinAction, null);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Make a new PIN for ${name}? The old one stops working and they are signed out everywhere.`)) e.preventDefault();
      }}
      className="space-y-2"
    >
      <input type="hidden" name="referee_id" value={refereeId} />
      <button className="btn-secondary text-xs" disabled={pending} data-testid="reset-pin">{pending ? "…" : "New PIN"}</button>
      <ShownOnce state={state} />
    </form>
  );
}

export function MasterCodeForm({ refereeId, groups, defaultGroup }: { refereeId: string; groups: { id: string; name: string }[]; defaultGroup: string | null }) {
  const [state, action, pending] = useActionState<RefereeFormState, FormData>(createMasterCodeAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="referee_id" value={refereeId} />
      <select name="event_group_id" className="input w-auto text-xs" defaultValue={defaultGroup ?? ""} aria-label="Master code covers">
        <option value="">Every open event</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>
      <select name="expires_days" className="input w-auto text-xs" defaultValue="7" aria-label="Expires">
        <option value="3">3 days</option>
        <option value="7">A week</option>
        <option value="30">30 days</option>
      </select>
      <button className="btn-secondary text-xs" disabled={pending} data-testid="make-master-code">{pending ? "…" : "Master code"}</button>
      <div className="w-full"><ShownOnce state={state} /></div>
    </form>
  );
}
