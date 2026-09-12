"use client";

import { useEffect, useState } from "react";
import { BEAT_SECONDS, watchingLabel, type PresencePage } from "@/lib/presence";

const KEY = "mb_visitor_id";

/**
 * An anonymous per-browser id, kept separate from the referee's device id.
 *
 * `mb_device_id` identifies the device holding a match's scoring lock. Reusing
 * it here would tie a public page view to the device scoring a court, so
 * presence gets its own id that means nothing anywhere else.
 *
 * Returns null rather than throwing when storage is unavailable — a private
 * window, a browser set to block site data, or a sandboxed preview frame. The
 * page must render either way; only the count is lost.
 */
function visitorId(): string | null {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/**
 * Reports that somebody is on this page, and shows how many others are.
 *
 * Deliberately not tied to the page's own refresh interval. Those vary from 4 to
 * 30 seconds by page, and beating on every one would triple the write load for a
 * cosmetic number; a fixed 20-second beat keeps the cost flat and predictable
 * however often a page happens to poll. The count comes back on the beat's own
 * response, so the figure updates without a second request and without waiting
 * for the page to re-render.
 *
 * Venue screens and control-room previews never render this: a wall is not a
 * person, and counting it would inflate every number an organiser looks at.
 */
export default function PresenceBeat({
  slug,
  page,
  kind = "tournament",
}: {
  slug: string;
  page: PresencePage;
  kind?: "tournament" | "session";
}) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const id = visitorId();
    if (!id) return;

    let cancelled = false;

    async function beat() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // keepalive so a beat already in flight survives the page being closed.
          keepalive: true,
          body: JSON.stringify({ slug, page, kind, visitorId: id }),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { watching?: number };
        if (!cancelled && typeof data.watching === "number") setCount(data.watching);
      } catch {
        // A missed beat costs nothing: the window is three beats wide.
      }
    }

    void beat();
    const timer = setInterval(beat, BEAT_SECONDS * 1000);
    // Beat immediately on return, so someone coming back to the tab is counted
    // again without waiting out the interval.
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug, page, kind]);

  const label = count === null ? null : watchingLabel(count);
  if (!label) return null;

  return (
    <span className="badge shrink-0 bg-success/15 text-success" title="People on this page right now">
      <span aria-hidden>●</span> {label}
    </span>
  );
}
