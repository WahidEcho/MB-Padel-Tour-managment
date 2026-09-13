"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export const STAGE_W = 1920;
export const STAGE_H = 1080;

// One object, returned every time: useSyncExternalStore requires a stable server
// snapshot, and a fresh literal on each call reads to it as a store that never
// settles.
const NATIVE = { w: STAGE_W, h: STAGE_H };
const nativeSnapshot = () => NATIVE;

/**
 * Tracks the host element's size. Kept outside React state so a resize updates
 * one transform and never re-renders the scene inside.
 */
function createViewport() {
  let size = NATIVE;
  const listeners = new Set<() => void>();
  return {
    set(w: number, h: number) {
      // Half a pixel of tolerance, or a ResizeObserver whose callback changes
      // layout by a sub-pixel amount feeds itself in a loop.
      if (Math.abs(w - size.w) < 0.5 && Math.abs(h - size.h) < 0.5) return;
      size = { w, h };
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get: () => size,
  };
}

/**
 * A literal 1920x1080 canvas, scaled once to fit whatever screen it is on.
 *
 * Every scene is authored in canvas pixels. A 65-inch venue panel, a 55-inch
 * panel and an operator's laptop then differ by a single scale factor, so a layout
 * checked once at 1920x1080 is checked everywhere — nothing inside measures the
 * viewport, and nothing reflows as the window changes. Letterboxed, never
 * stretched.
 *
 * The server renders at scale 1, which is also the correct answer on a native
 * 1920x1080 panel, so there is no hydration mismatch and no flash on boot.
 */
export default function BroadcastStage({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // State rather than a ref: it is created once and read during render, which a
  // ref may not be.
  const [viewport] = useState(createViewport);
  const size = useSyncExternalStore(viewport.subscribe, viewport.get, nativeSnapshot);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const read = () => viewport.set(host.clientWidth, host.clientHeight);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(host);
    return () => observer.disconnect();
  }, [viewport]);

  const scale = Math.min(size.w / STAGE_W, size.h / STAGE_H);
  const offsetX = (size.w - STAGE_W * scale) / 2;
  const offsetY = (size.h - STAGE_H * scale) / 2;

  return (
    <div ref={hostRef} className="bc-stage-host">
      <div
        className={`bc-stage ${className}`}
        data-stage-scale={scale.toFixed(4)}
        style={{ transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})` }}
      >
        {children}
      </div>
    </div>
  );
}
