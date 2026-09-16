"use client";

import { useEffect, useRef, useState } from "react";

export interface WatchableScreen {
  key: string;
  name: string;
  /** "Live courts", "Leaderboard"… what it is showing right now. */
  showing: string;
  /** "Court 1 and Court 2", or "Every court". */
  covers: string;
}

export interface WatchableCourt {
  /** Passed as ?court=, which the screen route resolves by name. */
  name: string;
  /** What is on it right now, or null when nothing is. */
  playing: string | null;
}

/**
 * The TV button on the public pages: watch what the venue screens are showing.
 *
 * A spectator at the back of a hall, or someone following from home, has no way
 * to reach the wall's view — the screen URLs are known only to the operator. This
 * lists them, with what each is showing, and opens the chosen one in its own tab
 * so the page they were reading is still there when they come back.
 *
 * Read-only in every sense: these are the same public screen URLs a TV uses, and
 * opening one changes nothing about what the venue sees.
 */
export default function WatchOnScreenMenu({
  slug,
  screens,
  courts,
}: {
  slug: string;
  screens: WatchableScreen[];
  courts: WatchableCourt[];
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (screens.length === 0 && courts.length === 0) return null;

  const link = (href: string, title: string, sub: string, key: string) => (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener"
      className="block rounded-lg px-3 py-2 hover:bg-background"
      onClick={() => setOpen(false)}
    >
      <p className="text-sm font-semibold leading-tight">{title}</p>
      <p className="text-xs leading-tight text-muted">{sub}</p>
    </a>
  );

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs font-semibold hover:bg-card"
        data-testid="watch-on-screen"
      >
        {/* A television, drawn rather than an emoji: an emoji is a different
            picture on every phone and some render it in colour at random sizes. */}
        <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="4" width="20" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" strokeLinecap="round" />
        </svg>
        Watch
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-card p-1 shadow-lg"
          data-testid="watch-menu"
        >
          {screens.length > 0 && (
            <>
              <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-muted">
                Venue screens
              </p>
              {screens.map((s) =>
                link(
                  `/t/${slug}/screen${s.key === "main" ? "" : `/${s.key}`}`,
                  s.name,
                  `${s.showing} · ${s.covers}`,
                  s.key,
                ),
              )}
            </>
          )}
          {courts.length > 0 && (
            <>
              <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-muted">
                One court, full screen
              </p>
              {courts.map((c) =>
                link(
                  `/t/${slug}/screen?court=${encodeURIComponent(c.name)}&mode=live`,
                  c.name,
                  c.playing ?? "Nothing on court now",
                  c.name,
                ),
              )}
            </>
          )}
          <p className="px-3 py-2 text-[10px] leading-snug text-muted">
            Opens the venue view in a new tab. It is built for a 16:9 screen, so it
            looks best full screen or cast to a TV.
          </p>
        </div>
      )}
    </div>
  );
}
