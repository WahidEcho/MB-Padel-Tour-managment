"use client";

import type { useScoringControl } from "./useScoringControl";

/**
 * Who is scoring this match, and the handoff between two devices.
 *
 * Three shapes, one for each thing this device can be right now: it holds the
 * lease (with an incoming request folded in, if there is one), someone else
 * holds it, or there is nothing to say because this device holds it and
 * nobody is asking — in which case the caller shows nothing at all.
 */
export default function ControlPanel({ control }: { control: ReturnType<typeof useScoringControl> }) {
  const { isController, heldByOther, holder, incomingRequest, myRequestPending, claim, release, requestControl, respond } = control;

  if (isController && incomingRequest) {
    return (
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-accent/15 px-3 py-2 text-xs font-semibold text-accent" data-testid="control-incoming-request">
        <span>{incomingRequest.deviceLabel ?? "Another device"} wants control of this match.</span>
        <span className="flex gap-2">
          <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void respond(true)} data-testid="control-accept">
            Hand over
          </button>
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => void respond(false)} data-testid="control-decline">
            Keep control
          </button>
        </span>
      </div>
    );
  }

  if (isController) {
    return (
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted" data-testid="control-holder">
        <span>You are scoring this match.</span>
        <button type="button" className="text-muted underline hover:text-foreground" onClick={() => void release()} data-testid="control-release">
          Release control
        </button>
      </div>
    );
  }

  if (heldByOther) {
    return (
      <div className="mb-2 rounded-xl bg-warning/15 px-3 py-2 text-xs font-semibold text-warning" data-testid="control-read-only">
        <p>Read-only — {holder?.deviceLabel ?? "another device"} is scoring this match.</p>
        {myRequestPending ? (
          <p className="mt-1 font-normal">Waiting for a reply…</p>
        ) : (
          <button type="button" className="btn-secondary mt-1.5 px-2 py-1 text-xs" onClick={() => void requestControl()} data-testid="control-request">
            Request control
          </button>
        )}
      </div>
    );
  }

  // Nobody is holding it. This only shows if the automatic claim on page-open
  // somehow lost a race in the same instant — an explicit retry, not a state
  // this page is expected to sit in for long.
  return (
    <div className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-background px-3 py-2 text-xs text-muted" data-testid="control-free">
      <span>Nobody is scoring this match right now.</span>
      <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void claim()} data-testid="control-claim">
        Take control
      </button>
    </div>
  );
}
