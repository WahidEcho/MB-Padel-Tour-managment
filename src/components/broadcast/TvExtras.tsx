"use client";

import type { ScoreState } from "@/lib/scoring/engine";
import { aceMoment } from "@/lib/scoring/serve";
import { TIMERS, liveClock } from "@/lib/scoring/timing";

export interface TvExtrasSwitches {
  /** The organiser's "Show aces on TV & app". */
  aces: boolean;
  /** The organiser's "Show timers on TV & app". */
  timers: boolean;
}

/** What a screen shows for scoring v2, from the live state: a running timer, the ACE moment, the aces count. */
export function tvExtras(state: ScoreState | null | undefined, now: number, on: TvExtrasSwitches | null | undefined) {
  if (!state || !on) return { clock: null, ace: false, aces: null as { A: number; B: number } | null };
  const clock = on.timers ? liveClock(state, now) : null;
  const aces = on.aces && state.stats && (state.stats.aces.A || state.stats.aces.B) ? state.stats.aces : null;
  return {
    clock: clock ? { label: clock.kind === "changeover" ? "Changeover" : TIMERS[clock.kind].label, text: clock.text, over: clock.over } : null,
    ace: on.aces && aceMoment(state),
    aces,
  };
}

/** A badge over a court card: the timer, or ACE. */
export default function TvExtras({ state, now, on }: { state: ScoreState | null | undefined; now: number; on: TvExtrasSwitches | null | undefined }) {
  const x = tvExtras(state, now, on);
  if (!x.clock && !x.ace) return null;
  return (
    <div className="pointer-events-none absolute right-4 top-4 z-10 flex flex-col items-end gap-2" data-testid="tv-extras">
      {x.clock && (
        <span className={`rounded-xl px-4 py-2 text-[28px] font-black tabular-nums ${x.clock.over ? "bg-[#e5133a] text-white" : "bg-black/70 text-white"}`} data-testid="tv-clock">
          {x.clock.label} {x.clock.text}
        </span>
      )}
      {x.ace && (
        <span className="rounded-xl bg-[#FFF500] px-5 py-2 text-[34px] font-black uppercase tracking-widest text-black" data-testid="tv-ace">
          Ace
        </span>
      )}
    </div>
  );
}
