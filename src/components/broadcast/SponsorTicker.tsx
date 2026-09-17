"use client";

import { useEffect, useRef, useState } from "react";
import { sizedImageSrc } from "@/lib/portrait";
import { logoBox, tickerPlan } from "@/lib/sponsors";
import type { MainSponsor, SponsorEntry } from "@/lib/types";

/**
 * The venue screen's sponsor band.
 *
 * The main partner is anchored, still, on the left; everyone else loops. Built
 * against the four ways the old marquee failed on a wall: logos in the duplicate
 * track loading lazily and never appearing, two copies running dry across 1920
 * pixels, speed tied to logo count instead of distance, and logos resizing as
 * they loaded so the loop's width kept changing under the animation.
 *
 * Every logo's box is known before it loads (its shape is measured on upload),
 * so one group's width is arithmetic, not a measurement. Only the viewport is
 * measured, with a half-pixel tolerance so the observer cannot feed itself.
 */
/** Padding inside each logo's chip. */
const CHIP_PAD = 8;

export default function SponsorTicker({
  main,
  sponsors,
  logoHeight = 52,
  gap = 72,
  chips = true,
  uniform = false,
}: {
  main: MainSponsor | null;
  sponsors: SponsorEntry[];
  logoHeight?: number;
  gap?: number;
  /** A white panel behind each logo (branding_config.sponsorChips). */
  chips?: boolean;
  /** One identical box for every logo (branding_config.sponsorUniformSize). */
  uniform?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  // A sensible first guess for the server render: the stage is 1920 wide and the
  // anchored partner takes a slice of it. Corrected on the first observation.
  const [width, setWidth] = useState(1500);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width;
      setWidth((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!main && sponsors.length === 0) return null;
  // Each logo sits in a chip with fixed padding, counted into the arithmetic so
  // the group width stays exact.
  const plan = tickerPlan(sponsors, width, logoHeight, gap + 2 * CHIP_PAD, uniform);
  // Without a panel the padding is still spent, so turning chips off moves no
  // logo: the band's arithmetic, and therefore its loop, is unchanged.
  const chipClass = chips ? "bc-logo-chip " : "";

  const group = (copy: number) => (
    <ul key={copy} className="flex shrink-0 items-center" aria-hidden={copy > 0 || undefined}>
      {sponsors.map((s, i) => {
        const box = logoBox(s.aspect, logoHeight, uniform);
        return (
          <li
            key={`${copy}-${i}`}
            className={`${chipClass}flex shrink-0 items-center justify-center`}
            style={{ width: box.width + 2 * CHIP_PAD, height: logoHeight + 2 * CHIP_PAD, marginRight: gap }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sizedImageSrc(s.logoUrl, Math.max(160, box.width * 2)) ?? s.logoUrl}
              alt={copy === 0 ? s.name || "Sponsor" : ""}
              width={box.width}
              height={box.height}
              // Never lazy: a venue screen does not scroll, so a lazy logo in a
              // later copy may never be requested — and exposure is contractual.
              loading="eager"
              decoding="async"
              className="object-contain"
              style={{
                width: box.width,
                height: box.height,
                // In uniform mode the box is the same for everybody and the logo
                // is contained inside it, so declaring its own ratio would fight
                // the box it has been given.
                aspectRatio: uniform || !s.aspect ? undefined : String(s.aspect),
              }}
            />
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex h-full items-center gap-8 px-10" data-testid="sponsor-ticker">
      {main && (
        <div className="flex shrink-0 items-center gap-5 border-r border-border pr-8">
          <p className="text-[22px] font-bold uppercase leading-tight tracking-widest text-muted">
            Main
            <br />
            partner
          </p>
          {(() => {
            const box = logoBox(main.aspect, logoHeight, uniform);
            return (
              <span className={`${chipClass}flex items-center justify-center`} style={{ padding: CHIP_PAD }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sizedImageSrc(main.logoUrl, Math.max(200, box.width * 2)) ?? main.logoUrl}
                  alt={main.name || "Main partner"}
                  width={box.width}
                  height={box.height}
                  loading="eager"
                  className="object-contain"
                  style={{ width: box.width, height: box.height }}
                />
              </span>
            );
          })()}
        </div>
      )}
      <div ref={viewport} className="bc-ticker-viewport relative h-full min-w-0 flex-1 overflow-hidden">
        {plan.copies > 0 && (
          <div
            data-ambient
            className="absolute inset-y-0 left-0 flex w-max items-center"
            style={
              {
                // Longhands only. The shorthand would reset the duration to the
                // stylesheet's value, and the crawl silently runs at that instead.
                animationName: "bc-ticker",
                animationDuration: `${plan.durationS}s`,
                animationTimingFunction: "linear",
                animationIterationCount: "infinite",
                "--bc-ticker-shift": `-${plan.groupWidth}px`,
              } as React.CSSProperties
            }
          >
            {Array.from({ length: plan.copies }, (_, i) => group(i))}
          </div>
        )}
      </div>
    </div>
  );
}
