"use client";

import { useState } from "react";
import { MAX_SCORE_DELAY_SECONDS, SCORE_DELAY_STEP, sanitizeScoreDelaySeconds, scoreDelayPreview } from "@/lib/live/delay";

/**
 * The delay meter (Admin → In the app → Score delay): a slider in steps of five
 * seconds and a number field for an exact value, kept in step, with the line fans
 * will read. Only the number field is posted (`seconds`); the server checks it again.
 */
export default function ScoreDelayMeter({ initial }: { initial: number }) {
  const [text, setText] = useState(String(sanitizeScoreDelaySeconds(initial)));
  const seconds = sanitizeScoreDelaySeconds(text);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="range"
          min={0}
          max={MAX_SCORE_DELAY_SECONDS}
          step={SCORE_DELAY_STEP}
          value={seconds}
          onChange={(e) => setText(e.target.value)}
          aria-label="Score delay in seconds"
          className="min-w-0 flex-1 accent-accent"
          data-testid="score-delay-range"
        />
        <label className="flex items-center gap-1 text-sm">
          <input
            name="seconds"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_SCORE_DELAY_SECONDS}
            step={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="input w-20 tabular-nums"
            data-testid="score-delay-seconds"
          />
          s
        </label>
      </div>
      <div className="flex justify-between text-[10px] uppercase tracking-widest text-muted" aria-hidden>
        <span>Live</span>
        <span>{MAX_SCORE_DELAY_SECONDS / 2} s</span>
        <span>{MAX_SCORE_DELAY_SECONDS} s</span>
      </div>
      <p className="text-sm font-semibold" data-testid="score-delay-preview" aria-live="polite">
        {scoreDelayPreview(seconds)}
      </p>
    </div>
  );
}
