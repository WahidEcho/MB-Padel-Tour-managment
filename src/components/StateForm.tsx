"use client";

import { useActionState } from "react";

export type FormState = { ok: boolean; message: string } | null;

/**
 * A form whose server action answers with a message (`{ ok, message }`) instead
 * of throwing: production hides a thrown error's words, and a refusal such as
 * "an organisation must keep one owner" has to reach the person. An optional
 * confirmation runs before submitting.
 */
export default function StateForm({
  action,
  children,
  className,
  confirm,
  testId,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
  testId?: string;
}) {
  const [state, run, pending] = useActionState<FormState, FormData>(action, null);
  return (
    <form
      action={run}
      className={className}
      data-testid={testId}
      aria-busy={pending}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {state && (
        <p className={`text-xs font-semibold ${state.ok ? "text-success" : "text-danger"}`} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
