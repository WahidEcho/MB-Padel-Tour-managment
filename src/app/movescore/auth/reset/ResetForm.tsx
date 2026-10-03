"use client";

import { useActionState, useState, useSyncExternalStore } from "react";
import { LISTED_RULES, passwordChecks } from "@/lib/auth/password";
import type { ResetState } from "@/lib/auth/links";
import { resetPassword } from "../actions";

const noSubscribe = () => () => {};
let captured: string | null = null;
/** The recovery session from the URL fragment, read once; the fragment is then wiped from the address bar. */
function recoveryFragment(): string {
  if (captured === null) {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const t = hash.get("access_token");
    captured = t && hash.get("type") === "recovery" ? t : "";
    if (captured) history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return captured;
}

/** New password, twice, with the same live checklist the app shows. */
export function ResetForm({ tokenHash, type }: { tokenHash: string; type: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(resetPassword, null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  // An older link carries the session in the fragment instead of a token hash.
  const fragmentToken = useSyncExternalStore(noSubscribe, recoveryFragment, () => "");

  if (state?.ok) {
    return (
      <div className="card space-y-3" role="status">
        <p className="text-lg font-bold">Password changed</p>
        <p className="text-muted">{state.message}</p>
        <a href="movescore://auth/confirmed" className="btn-primary inline-flex rounded-xl px-5 py-3 font-bold">
          Open Move Score
        </a>
      </div>
    );
  }

  const linkMissing = !fragmentToken && !(tokenHash && type === "recovery");
  const accessToken = (state && !state.ok && state.accessToken) || fragmentToken;
  const checks = passwordChecks(password).filter((c) => LISTED_RULES.includes(c.rule) || !c.ok);
  const mismatch = confirm.length > 0 && confirm !== password;

  if (linkMissing || (state && !state.ok && state.expired)) {
    return (
      <div className="card space-y-2" role="alert">
        <p className="font-bold">This link can&apos;t be used</p>
        <p className="text-muted">
          {state && !state.ok && state.expired ? state.error : "Open the newest reset email we sent, or in Move Score tap “Forgot password?” to get a new link."}
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="card max-w-md space-y-4">
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="access_token" value={accessToken} />
      <div className="space-y-1">
        <label className="label" htmlFor="password">
          New password
        </label>
        <div className="flex gap-2">
          <input
            id="password"
            name="password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            className="input flex-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button type="button" className="btn-secondary rounded-lg px-3 text-sm" onClick={() => setShow((s) => !s)} aria-pressed={show}>
            {show ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      <ul className="space-y-1 text-sm" aria-label="Password rules">
        {checks.map((c) => (
          <li key={c.rule} className={c.ok ? "text-accent" : "text-muted"}>
            {c.ok ? "✓" : "○"} {c.label}
          </li>
        ))}
      </ul>
      <div className="space-y-1">
        <label className="label" htmlFor="confirm">
          Type it again
        </label>
        <input
          id="confirm"
          name="confirm"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          className="input w-full"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        {mismatch && <p className="text-sm text-red-400">The two passwords don&apos;t match.</p>}
      </div>
      {state && !state.ok && (
        <p className="text-sm text-red-400" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="btn-primary w-full rounded-xl py-3 font-bold" disabled={pending || mismatch || checks.some((c) => !c.ok)}>
        {pending ? "Saving…" : "Save new password"}
      </button>
    </form>
  );
}
