"use client";

import { useActionState } from "react";
import { applyAction, type ApplyState } from "./actions";

function Field({ name, label, type = "text", required, max, rows, hint }: { name: string; label: string; type?: string; required?: boolean; max: number; rows?: number; hint?: string }) {
  return (
    <div>
      <label className="label" htmlFor={`apply-${name}`}>{label}{required ? "" : " (optional)"}</label>
      {rows ? (
        <textarea id={`apply-${name}`} name={name} rows={rows} maxLength={max} className="input" required={required} />
      ) : (
        <input id={`apply-${name}`} name={name} type={type} maxLength={max} className="input" required={required} />
      )}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export default function ApplyForm({ via }: { via: "web" | "app" }) {
  const [state, action, pending] = useActionState<ApplyState, FormData>(applyAction, null);
  if (state?.ok) {
    return (
      <div className="card space-y-2" data-testid="apply-done">
        <h2 className="text-lg font-bold">Thank you</h2>
        <p className="text-sm">
          Move Beyond will review your application and write to <strong>{state.email}</strong>. Once it is approved you get an
          email with a link to set up your organisation&apos;s staff access.
        </p>
      </div>
    );
  }
  return (
    <form action={action} className="card space-y-3" data-testid="apply-form">
      <input type="hidden" name="via" value={via} />
      {/* Never shown to people; a bot that fills it is ignored. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
        <label htmlFor="apply-company_fax">Fax</label>
        <input id="apply-company_fax" name="company_fax" tabIndex={-1} autoComplete="off" />
      </div>
      <Field name="name" label="Organisation name" required max={120} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="contact_name" label="Your name" required max={120} />
        <Field name="contact_email" label="Your email" type="email" required max={254} hint="We write to you here, and the approval invite goes to this address." />
        <Field name="contact_phone" label="Phone" type="tel" max={40} />
        <Field name="sport" label="Sport" max={40} />
        <Field name="city" label="City" max={80} />
        <Field name="country" label="Country" max={80} />
      </div>
      <Field name="website" label="Website or social page" type="url" max={200} />
      <Field name="about" label="About your organisation and its events" rows={4} max={2000} />
      <p className="text-xs text-muted">Never put passwords or codes in this form. Move Beyond never asks for them.</p>
      {state?.ok === false && <p className="text-sm font-semibold text-danger" role="alert">{state.message}</p>}
      <button className="btn-primary" disabled={pending}>{pending ? "Sending…" : "Send application"}</button>
    </form>
  );
}
