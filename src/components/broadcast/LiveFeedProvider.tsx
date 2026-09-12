"use client";

import { createContext, useContext } from "react";
import type { ClockAnchor } from "@/lib/tv/timeline";
import type { LiveFeed } from "@/lib/tv/liveFeed";
import { useAnchoredNow, useLiveFeed, useMotionAllowed } from "./hooks";

interface LiveContext {
  feed: LiveFeed | null;
  anchor: ClockAnchor | null;
  now: number;
  motion: boolean;
  /** Milliseconds between the two most recent successful polls. */
  pollGapMs: number;
}

const Ctx = createContext<LiveContext>({ feed: null, anchor: null, now: 0, motion: true, pollGapMs: 2_000 });

export function useLive(): LiveContext {
  return useContext(Ctx);
}

/**
 * Owns the one poll on a venue screen.
 *
 * Mounted around the whole stage and always running, whatever the screen is
 * showing — so a screen on the leaderboard still notices when an operator
 * switches it to live courts, and still triggers a server render when a match
 * finishes and the standings change.
 */
export default function LiveFeedProvider({
  slug,
  screenKey,
  initial,
  preview = false,
  refreshOnScore = false,
  children,
}: {
  slug: string;
  screenKey: string;
  initial: LiveFeed;
  /** A control-room thumbnail polls more slowly than the wall it mirrors. */
  preview?: boolean;
  /** Chess boards live outside the lean feed, so they redraw via the server. */
  refreshOnScore?: boolean;
  children: React.ReactNode;
}) {
  const { feed, anchor, pollGapMs } = useLiveFeed(slug, screenKey, {
    intervalMs: preview ? 5_000 : 2_000,
    initial,
    refreshOnScore,
  });
  const now = useAnchoredNow(anchor, 250);
  const current = feed ?? initial;
  // A thumbnail never animates: it is a picture of the wall, not a second show.
  const motion = useMotionAllowed(current.screen.mute_animations || preview, true);

  return (
    <Ctx.Provider value={{ feed: current, anchor, now, motion, pollGapMs }}>
      <div className={motion ? "contents" : "bc-still contents"}>{children}</div>
    </Ctx.Provider>
  );
}
