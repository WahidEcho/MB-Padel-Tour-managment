"use client";

import { useActionState } from "react";
import type { DisplayMode } from "@/lib/types";
import type { ScreenFormState } from "@/app/operator/tournaments/[id]/control/actions";

export const MODES: { mode: DisplayMode; label: string; hint: string }[] = [
  { mode: "live", label: "🎾 Live courts", hint: "The courts this screen covers" },
  { mode: "leaderboard", label: "📊 Leaderboard", hint: "Group standings" },
  { mode: "bracket", label: "🏆 Bracket", hint: "Knockout tree" },
  // The ceremony supersedes the static winner scene; screens saved on "winner"
  // still render it, and read as the ceremony here.
  { mode: "ceremony", label: "🥇 Ceremony", hint: "Podium, revealed place by place" },
  { mode: "sponsors", label: "🤝 Sponsors", hint: "Full-screen sponsor logos" },
  { mode: "holding", label: "⏸ Holding", hint: "Between matches" },
];

/** The live modes are stored distinctly on old rows but mean the same thing. */
export function isLiveMode(mode: DisplayMode): boolean {
  return mode === "live" || mode === "live_court" || mode === "all_live";
}

type Action = (state: ScreenFormState, formData: FormData) => Promise<ScreenFormState>;

/**
 * One row of mode buttons.
 *
 * A client form rather than a plain one so a conflict can be shown in place: a
 * server action invoked from a plain form has no status code, and a thrown
 * conflict lands on the default error page — mid-event, in front of a room.
 */
export default function ScreenModePicker({
  action,
  hidden,
  current,
  label,
  disabled = false,
}: {
  action: Action;
  /**
   * Fields every submission carries, e.g. tournament id, key, revision. An
   * array value emits one input per entry, which is how a push-to-many carries
   * its list of target screens.
   */
  hidden: Record<string, string | string[]>;
  current?: DisplayMode;
  label?: string;
  disabled?: boolean;
}) {
  const [state, submit, pending] = useActionState<ScreenFormState, FormData>(action, null);

  return (
    <div className="space-y-2">
      {label && <p className="label">{label}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {MODES.map(({ mode, label: modeLabel, hint }) => {
          const active =
            current !== undefined &&
            (mode === "live" ? isLiveMode(current) : mode === "ceremony" ? current === "ceremony" || current === "winner" : current === mode);
          return (
            <form key={mode} action={submit}>
              {Object.entries(hidden).flatMap(([name, value]) =>
                (Array.isArray(value) ? value : [value]).map((v, i) => (
                  <input key={`${name}-${i}`} type="hidden" name={name} value={v} />
                )),
              )}
              <input type="hidden" name="display_mode" value={mode} />
              <button
                disabled={disabled || pending}
                className={`card w-full text-left transition hover:border-accent disabled:opacity-60 ${
                  active ? "border-accent bg-accent/10" : ""
                }`}
              >
                <p className="text-sm font-bold">{modeLabel}</p>
                <p className="text-xs text-muted">{hint}</p>
              </button>
            </form>
          );
        })}
      </div>
      {state && (
        <p
          className={`text-xs font-semibold ${
            state.ok ? "text-success" : "conflict" in state ? "text-warning" : "text-danger"
          }`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
