"use client";

import { useActionState } from "react";
import type { ScreenFormState } from "@/app/operator/tournaments/[id]/control/actions";

export interface CommandButton {
  /** The command a press sends, e.g. "ceremony_next". */
  command: string;
  label: string;
  /** Extra fields for this button only, e.g. { break_minutes: "10" }. */
  fields?: Record<string, string>;
  tone?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  /** Asked before sending, for the controls that interrupt what is on air. */
  confirm?: string;
}

type Action = (state: ScreenFormState, formData: FormData) => Promise<ScreenFormState>;

/**
 * A row of live controls that report back in place.
 *
 * Each button is its own form carrying the command, so a press sends exactly one
 * thing; all of them share one result line, so the operator reads what the last
 * press did — or why it was refused — right under the buttons.
 */
export default function ScreenCommandBar({
  action,
  hidden,
  buttons,
  testId,
}: {
  action: Action;
  /** Fields every press carries: tournament, screen key and revision, or target screens. */
  hidden: Record<string, string | string[]>;
  buttons: CommandButton[];
  testId?: string;
}) {
  const [state, submit, pending] = useActionState<ScreenFormState, FormData>(action, null);
  const toneClass = { primary: "btn-primary", secondary: "btn-secondary", danger: "btn-danger" };

  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <form
            key={`${b.command}-${b.label}`}
            action={submit}
            onSubmit={(e) => {
              if (b.confirm && !window.confirm(b.confirm)) e.preventDefault();
            }}
          >
            {Object.entries(hidden).flatMap(([name, value]) =>
              (Array.isArray(value) ? value : [value]).map((v, i) => (
                <input key={`${name}-${i}`} type="hidden" name={name} value={v} />
              )),
            )}
            <input type="hidden" name="command" value={b.command} />
            {Object.entries(b.fields ?? {}).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <button className={`${toneClass[b.tone ?? "secondary"]} text-xs`} disabled={pending || b.disabled}>
              {b.label}
            </button>
          </form>
        ))}
      </div>
      {state && (
        <p
          role={state.ok ? "status" : "alert"}
          className={`text-xs font-semibold ${state.ok ? "text-success" : "conflict" in state ? "text-warning" : "text-danger"}`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
