"use client";

import { useActionState, useState } from "react";
import { inviteMember, type InviteFormState } from "./actions";

/** Invite by email. The link is shown once (to copy into WhatsApp if the email is slow) and emailed. */
export default function InviteForm({ roles }: { roles: { value: string; label: string }[] }) {
  const [state, action, pending] = useActionState<InviteFormState, FormData>(inviteMember, null);
  const [copied, setCopied] = useState(false);
  return (
    <form action={action} className="card grid gap-3 sm:grid-cols-3" data-testid="invite-form">
      <div className="sm:col-span-2">
        <label className="label" htmlFor="invite-email">Email</label>
        <input id="invite-email" name="email" type="email" required maxLength={254} className="input" placeholder="name@example.com" />
      </div>
      <div>
        <label className="label" htmlFor="invite-role">Role</label>
        <select id="invite-role" name="role" className="input" defaultValue={roles.find((r) => r.value === "manager") ? "manager" : roles[0]?.value}>
          {roles.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-3">
        <button className="btn-primary" disabled={pending}>{pending ? "Inviting…" : "Send invite"}</button>
      </div>
      {state?.ok === false && <p className="text-sm text-danger sm:col-span-3">{state.message}</p>}
      {state?.ok && (
        <div className="space-y-2 rounded-xl border border-success/40 bg-success/10 p-3 sm:col-span-3" data-testid="new-invite">
          <p className="text-sm">
            {state.emailed ? `Emailed to ${state.email}.` : `Could not email ${state.email}: send them this link yourself.`} It works once, for that
            address only, for 7 days. Shown once: only its fingerprint is kept.
          </p>
          <div className="flex gap-2">
            <input readOnly value={state.link} className="input font-mono text-xs" aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => void navigator.clipboard?.writeText(state.link).then(() => setCopied(true))}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
