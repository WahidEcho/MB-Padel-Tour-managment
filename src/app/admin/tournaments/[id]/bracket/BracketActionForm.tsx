"use client";

import { useActionState } from "react";
import type { BracketFormState } from "./actions";

/**
 * One Bracket page button that reports back.
 *
 * The server's answer — a refusal to delete played matches, a confirmation that
 * went stale, a publish that would duplicate matches — is shown under the button
 * instead of an error page. Everything the confirmation describes comes from
 * props, which every submit revalidates, so the next click always confirms the
 * bracket as it is now.
 */
export default function BracketActionForm({
  action,
  fields,
  label,
  className,
  confirmMessage = null,
  children,
  testId,
  hidden = false,
  stamp,
}: {
  action: (prev: BracketFormState, formData: FormData) => Promise<BracketFormState>;
  /** Hidden inputs: tournament, tier and, for Redraw and Reset, the fingerprint confirmed. */
  fields: Record<string, string>;
  label: string;
  className: string;
  confirmMessage?: string | null;
  /** Extra inputs rendered inside the form, above the button. */
  children?: React.ReactNode;
  testId?: string;
  /**
   * Hide the button but stay mounted. A submit often changes what the page
   * offers — an approve that finds the bracket already published, a reset that
   * removes the bracket — and unmounting would throw away the very message
   * explaining what happened.
   */
  hidden?: boolean;
  /**
   * The bracket state this form is showing (see bracketStamp). A result is shown
   * only while it was produced under the same state, so a message about a bracket
   * that has since been redrawn, published or reset disappears instead of sitting
   * under a button it no longer describes.
   */
  stamp: string;
}) {
  const [state, formAction, pending] = useActionState<BracketFormState, FormData>(action, null);

  return (
    <div className="flex flex-col items-start gap-1" data-testid={testId}>
      {!hidden && (
      <form
        action={formAction}
        className={children ? "space-y-2" : undefined}
        onSubmit={(e) => {
          if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
        }}
      >
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {children}
        <button className={className} disabled={pending}>
          {pending ? "Working…" : label}
        </button>
      </form>
      )}
      {state && state.stamp === stamp && (
        <p
          role={state.ok ? "status" : "alert"}
          className={`max-w-sm text-xs ${
            state.ok ? "font-semibold text-success" : state.reason === "played" || state.reason === "changed" ? "text-warning" : "text-danger"
          }`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
