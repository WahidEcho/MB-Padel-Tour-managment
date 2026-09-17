"use client";

import { useEffect, useRef, useState } from "react";
import { sizedImageSrc } from "@/lib/portrait";

/** Pixels the band travels each second. Slow enough to read a wordmark. */
const PX_PER_SECOND = 40;

/**
 * Sponsor and partner logos looping along the bottom of the public pages.
 *
 * Two copies of the list are not a loop. They are a loop only while two copies
 * are wider than the viewport — otherwise the track runs out and the band shows
 * a blank stretch before it jumps back, which is what a wide browser did to a
 * short sponsor list. So the group is measured once it has laid out and enough
 * copies are rendered to cover the viewport with one to spare. Measuring rather
 * than calculating also means a logo that loads late, and changes the group's
 * width as it does, is picked up instead of shifting the seam.
 *
 * The animation is a CSS one on a transform, so it runs on the compositor and
 * costs nothing on a phone. Respects prefers-reduced-motion: it stops, and the
 * row scrolls by hand instead.
 */
export default function SponsorMarquee({
  logos,
  label = "Our partners",
  /** Bigger on a TV; the default suits phones and admin pages. */
  size = "normal",
}: {
  logos: string[];
  label?: string;
  size?: "normal" | "big";
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLUListElement>(null);
  const [groupWidth, setGroupWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  // Bumped by each logo as it loads. A logo with no width or height attribute
  // lays out at nothing until its bytes arrive, so the first measurement of the
  // group is the gap alone — and a loop built from that is wrong in both
  // directions at once: far too many copies, and a shift far too short.
  const [loaded, setLoaded] = useState(0);
  // The prop is a fresh array on every render of the server component that owns
  // it, so the identity is useless as a dependency.
  const key = logos.join("|");

  useEffect(() => {
    const vp = viewport.current;
    const gp = group.current;
    if (!vp || !gp) return;
    // A half-pixel tolerance, so the observer cannot feed itself through the
    // width its own answer caused.
    const measure = () => {
      setViewportWidth((prev) => (Math.abs(prev - vp.offsetWidth) > 0.5 ? vp.offsetWidth : prev));
      setGroupWidth((prev) => (Math.abs(prev - gp.offsetWidth) > 0.5 ? gp.offsetWidth : prev));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    ro.observe(gp);
    measure();
    return () => ro.disconnect();
  }, [key, loaded]);

  const clean = logos.filter(Boolean);
  if (clean.length === 0) return null;

  const height = size === "big" ? "h-20 sm:h-24" : "h-10 sm:h-12";
  // One copy past the viewport, so the seam is always off-screen. Until the logos
  // have laid out, two copies — the same as before, and never fewer. Capped, so a
  // measurement taken mid-load cannot ask for hundreds of copies of the list.
  const measured = groupWidth > 40;
  // The cap is a runaway guard, not a layout rule: at 60 copies even a single
  // narrow logo covers any screen, and nothing legitimate reaches it.
  const copies = measured ? Math.min(60, Math.max(2, Math.ceil(viewportWidth / groupWidth) + 1)) : 2;
  const durationS = measured ? Math.max(10, groupWidth / PX_PER_SECOND) : 30;

  const track = (copy: number) => (
    <ul
      key={copy}
      ref={copy === 0 ? group : undefined}
      className="flex shrink-0 items-center gap-8 pr-8"
      aria-hidden={copy > 0 || undefined}
    >
      {clean.map((src, i) => (
        <li key={`${copy}-${src}-${i}`} className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={sizedImageSrc(src, size === "big" ? 480 : 240) ?? src}
            alt={copy === 0 ? `Sponsor ${i + 1}` : ""}
            className={`${height} w-auto object-contain opacity-80 transition-opacity hover:opacity-100`}
            // A venue screen never scrolls, so a lazy logo in a duplicated track
            // may never load at all — and sponsor exposure is contractual.
            loading="eager"
            onLoad={copy === 0 ? () => setLoaded((n) => n + 1) : undefined}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <section className="w-full overflow-hidden py-3" aria-label={label}>
      {label && (
        <p className="mb-2 text-center text-xs font-bold uppercase tracking-widest text-muted">
          {label}
        </p>
      )}
      <div ref={viewport} className="marquee-viewport relative overflow-hidden">
        <div
          className="marquee-track flex w-max"
          style={
            {
              animationDuration: `${durationS}s`,
              // Exactly one group, so the frame after the last is the first again.
              "--marquee-shift": measured ? `-${groupWidth}px` : "-50%",
            } as React.CSSProperties
          }
        >
          {Array.from({ length: copies }, (_, i) => track(i))}
        </div>
      </div>
    </section>
  );
}
