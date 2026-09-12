"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { anchoredNow, elapsedSince, stageForElapsed, type ClockAnchor, type StageOptions } from "@/lib/tv/timeline";
import { needsStructuralRefresh, type LiveFeed } from "@/lib/tv/liveFeed";

/**
 * Polls the venue screen's live feed.
 *
 * Replaces a timed router.refresh() on the TV route, for one reason: failure
 * behaviour. In this version of Next a server-render fetch that fails falls back
 * to a full page navigation, so a flaky venue uplink would flash the wall white
 * and reload it mid-animation. Here a failed poll is ignored and the previous
 * payload stays — which is the only place "keep the last good frame" can actually
 * be implemented, because this hook owns the result.
 *
 * Polls on a self-re-arming timeout rather than an interval, so a slow response
 * cannot let requests pile up behind it. The server render runs again only when a
 * successful poll reports a structural change; a scored point never costs one.
 */
export function useLiveFeed(
  slug: string,
  screenKey: string,
  {
    intervalMs = 2_000,
    initial = null,
    refreshOnScore = false,
  }: {
    intervalMs?: number;
    initial?: LiveFeed | null;
    /**
     * Re-render on every score change, not only structural ones. For a sport
     * whose on-screen state lives outside the lean feed — a chess board's
     * position — the server render is the only thing that can redraw it.
     */
    refreshOnScore?: boolean;
  } = {},
): { feed: LiveFeed | null; anchor: ClockAnchor | null; lastOkAt: number | null; pollGapMs: number } {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [feed, setFeed] = useState<LiveFeed | null>(initial);
  const [anchor, setAnchor] = useState<ClockAnchor | null>(
    initial ? { serverMs: initial.fetchedAt, clientMs: initial.fetchedAt } : null,
  );
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  // How long the screen went between two successful looks. This, not the time
  // since the score last changed, is what tells a live card whether it can trust
  // a difference: polls keep arriving every couple of seconds through a long
  // rally, and only stop when the tab is hidden or the connection is down.
  const [pollGapMs, setPollGapMs] = useState(intervalMs);
  const previous = useRef<LiveFeed | null>(initial);
  const lastArrival = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = `/api/t/${encodeURIComponent(slug)}/live?screen=${encodeURIComponent(screenKey)}`;

    async function tick() {
      // A hidden tab does not poll; it catches up on the next visible tick.
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (res.status === 404) {
            // Not a network blip: the screen was deleted, or the tournament taken
            // off public view. Stop showing stale content — let the page render
            // its own not-found instead of holding the last frame forever.
            if (!cancelled) startTransition(() => router.refresh());
          } else if (res.ok) {
            const next = (await res.json()) as LiveFeed;
            if (!cancelled) {
              const arrived = Date.now();
              setPollGapMs(lastArrival.current === null ? intervalMs : arrived - lastArrival.current);
              lastArrival.current = arrived;
              setAnchor({ serverMs: next.fetchedAt, clientMs: arrived });
              setLastOkAt(arrived);
              const scoreMoved =
                refreshOnScore &&
                previous.current !== null &&
                scoreSignature(previous.current) !== scoreSignature(next);
              if (scoreMoved || needsStructuralRefresh(previous.current, next)) {
                startTransition(() => router.refresh());
              }
              previous.current = next;
              setFeed(next);
            }
          }
          // Any other status, like a network error, falls through: the last good
          // payload stays on the wall.
        } catch {
          // Deliberately nothing: the last good payload stays on the wall.
        }
      }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [slug, screenKey, intervalMs, refreshOnScore, router]);

  return { feed, anchor, lastOkAt, pollGapMs };
}

/** Every match's event number, so any score change changes the signature. */
function scoreSignature(feed: LiveFeed): string {
  return feed.snapshots.map((s) => `${s.match_id}:${s.last_event_number}`).sort().join("|");
}

/** A clock corrected to the server, ticking at the given rate. */
export function useAnchoredNow(anchor: ClockAnchor | null, tickMs = 250): number {
  const [now, setNow] = useState(() => anchoredNow(anchor, Date.now()));
  useEffect(() => {
    // No synchronous set here: the initialiser covers mount, and a new anchor is
    // picked up on the next tick, a quarter of a second later.
    const id = setInterval(() => setNow(anchoredNow(anchor, Date.now())), tickMs);
    return () => clearInterval(id);
  }, [anchor, tickMs]);
  return now;
}

/**
 * The stage of a timeline that started at `startIso`.
 *
 * Seeked, not mounted: re-derived from the elapsed time on every tick, so a card
 * that re-renders or remounts lands on the same frame instead of starting over.
 * A change to `startIso` — a match re-confirmed after an undo, an entrance
 * replayed by the operator — is simply a new origin, and the stage follows it.
 */
export function useSeekedStage(
  marks: number[],
  startIso: string | null | undefined,
  now: number,
  opts: StageOptions = {},
): { stage: number; elapsedMs: number | null } {
  const elapsedMs = elapsedSince(startIso, now);
  return { stage: stageForElapsed(marks, elapsedMs, opts), elapsedMs };
}

const noopSubscribe = () => () => {};

/**
 * Whether this screen should move at all.
 *
 * A venue PC's reduced-motion setting was chosen by nobody in the room, so the
 * wall ignores it by default — but the operator's MUTE control and a genuine
 * reduced-motion preference on a personal device are both honoured.
 */
export function useMotionAllowed(mutedByOperator: boolean, isVenueScreen: boolean): boolean {
  const prefersReduced = useSyncExternalStore(
    noopSubscribe,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  if (mutedByOperator) return false;
  return isVenueScreen || !prefersReduced;
}
