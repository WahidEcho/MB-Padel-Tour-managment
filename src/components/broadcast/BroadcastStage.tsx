"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { STAGE, stageFor, type StageAspect } from "@/lib/tv/layout";

export const STAGE_W = 1920;
export const STAGE_H = 1080;

// One object, returned every time: useSyncExternalStore requires a stable server
// snapshot, and a fresh literal on each call reads to it as a store that never
// settles.
const NATIVE = { w: STAGE_W, h: STAGE_H };
const nativeSnapshot = () => NATIVE;

/** The canvas the scenes are drawn on: 1920x1080, or 1920x1200 on a 16:10 wall. */
const StageSize = createContext<{ width: number; height: number }>(STAGE);

export function useStageSize(): { width: number; height: number } {
  return useContext(StageSize);
}

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
 * A literal canvas, scaled once to fit whatever screen it is on.
 *
 * Every scene is authored in canvas pixels. A 65-inch venue panel, a 55-inch
 * panel and an operator's laptop then differ by a single scale factor, so a layout
 * checked once is checked everywhere — nothing inside measures the viewport, and
 * nothing reflows as the window changes. Letterboxed, never stretched.
 *
 * The canvas is 1920x1080, or 1920x1200 when the host is about 16:10 (a 4 m x
 * 2.5 m LED wall; stageFor) so that wall is filled instead of banded. Scenes read
 * the height through useStageSize and the `--stage-h` CSS variable.
 *
 * The server renders 1920x1080 at scale 1, which is also the correct answer on a
 * native 1920x1080 panel, so there is no hydration mismatch. The host is first
 * measured in a layout effect, before the browser paints, so a 16:10 wall goes
 * straight to its tall canvas without a visible jump.
 */
export default function BroadcastStage({
  children,
  className = "",
  aspect = "auto",
}: {
  children: React.ReactNode;
  className?: string;
  /** Force a canvas (the screen URL's ?aspect=16:10); auto by default. */
  aspect?: StageAspect;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // State rather than a ref: it is created once and read during render, which a
  // ref may not be.
  const [viewport] = useState(createViewport);
  const size = useSyncExternalStore(viewport.subscribe, viewport.get, nativeSnapshot);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const read = () => viewport.set(host.clientWidth, host.clientHeight);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(host);
    return () => observer.disconnect();
  }, [viewport]);

  // Before the first measurement the snapshot is the native size, which keeps 1080.
  const canvas = stageFor(size.w, size.h, aspect);
  const scale = Math.min(size.w / canvas.width, size.h / canvas.height);
  const offsetX = (size.w - canvas.width * scale) / 2;
  const offsetY = (size.h - canvas.height * scale) / 2;

  return (
    <div ref={hostRef} className="bc-stage-host">
      <div
        className={`bc-stage ${className}`}
        data-stage-scale={scale.toFixed(4)}
        data-stage-height={canvas.height}
        style={{ transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`, height: canvas.height, "--stage-h": `${canvas.height}px` } as React.CSSProperties}
      >
        <StageSize.Provider value={canvas}>{children}</StageSize.Provider>
      </div>
    </div>
  );
}
