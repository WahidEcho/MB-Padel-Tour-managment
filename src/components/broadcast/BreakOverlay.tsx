"use client";

import { breakRemainingSeconds, formatCountdown } from "@/lib/tv/commands";
import { useLive } from "./LiveFeedProvider";

/**
 * The break countdown, over whatever the screen was showing.
 *
 * Counted from the server's stamp on the server-anchored clock, so a TV that is
 * reloaded mid-break, or a second wall, shows the same seconds. At zero it holds
 * on "Back shortly" until the operator ends the break: the break is over when
 * play resumes, not when a timer says so. Covers the content row only, so the
 * header and the sponsor band stay on air.
 */
export default function BreakOverlay({ title }: { title: string }) {
  const { feed, now } = useLive();
  const remaining = breakRemainingSeconds(feed?.screen.break_ends_at, now);
  if (remaining === null) return null;

  return (
    <div
      data-testid="break-overlay"
      className="absolute inset-0 flex flex-col items-center justify-center gap-6 text-center"
      style={{ zIndex: 30, background: "color-mix(in oklab, var(--background) 90%, transparent)" }}
    >
      <p className="text-[40px] font-bold uppercase tracking-[0.3em] text-muted">{title}</p>
      {remaining > 0 ? (
        <>
          <p className="text-[64px] font-black leading-none">Back in</p>
          <p className="bc-num text-[260px] font-black leading-none text-accent" data-numeral data-testid="break-countdown">
            {formatCountdown(remaining)}
          </p>
        </>
      ) : (
        <p className="text-[140px] font-black leading-none" data-testid="break-back-shortly">
          Back shortly
        </p>
      )}
    </div>
  );
}
