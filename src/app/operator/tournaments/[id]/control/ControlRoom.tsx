"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import type { Court, ScreenSettings } from "@/lib/types";
import ScreenModePicker, { isLiveMode } from "@/components/ScreenModePicker";
import { addScreen, applyToScreens, type ScreenFormState } from "./actions";

function screenLabel(s: ScreenSettings) {
  return s.screen_name ?? (s.screen_key === "main" ? "Main screen" : s.screen_key);
}

function coverageLabel(s: ScreenSettings, courts: Court[]) {
  if (!s.court_ids?.length) return "All courts";
  const names = courts.filter((c) => s.court_ids.includes(c.id)).map((c) => c.court_name);
  return names.length ? names.join(", ") : "No courts (none of these still exist)";
}

/**
 * Every wall in the venue, on one page.
 *
 * The thumbnails are real iframes of each screen's own public URL, so what the
 * operator sees is what is on air rather than a mock-up that can drift from it.
 * They poll more slowly than the walls and cannot be clicked into: a stray
 * click inside a preview must not navigate a page a TV is mirroring.
 */
export default function ControlRoom({
  tournamentId,
  slug,
  screens,
  courts,
  publicAccess,
  canManage,
}: {
  tournamentId: string;
  slug: string;
  screens: ScreenSettings[];
  courts: Court[];
  publicAccess: boolean;
  canManage: boolean;
}) {
  const [addState, add, adding] = useActionState<ScreenFormState, FormData>(addScreen, null);
  const [selected, setSelected] = useState<string[]>([]);

  const targets = selected.length > 0 ? selected : screens.map((s) => s.screen_key);
  const targetLabel =
    selected.length === 0
      ? `all ${screens.length} screen${screens.length === 1 ? "" : "s"}`
      : `${selected.length} selected`;

  return (
    <div className="space-y-4">
      {/* ---------------- Push to many ---------------- */}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-bold">Push to {targetLabel}</h2>
            <p className="text-xs text-muted">
              Sets what every chosen screen is showing in one click. Which courts each screen covers
              is set on the screen itself, and is never changed from here.
            </p>
          </div>
          {selected.length > 0 && (
            <button type="button" className="btn-secondary text-xs" onClick={() => setSelected([])}>
              Clear selection
            </button>
          )}
        </div>

        {/* The target list rides inside each mode form, so a click pushes to
            exactly the screens shown in the heading. */}
        <ScreenModePicker
          action={applyToScreens}
          hidden={{ tournament_id: tournamentId, screen_key: targets }}
          disabled={screens.length === 0}
        />
      </div>

      {/* ---------------- The wall of walls ---------------- */}
      {!publicAccess && (
        <p className="rounded-xl bg-warning/10 px-3 py-2 text-xs font-semibold text-warning">
          Public access is off for this tournament, so the screens below cannot load. Turn it on in
          Settings before the event.
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {screens.map((s) => {
          const url = s.screen_key === "main" ? `/t/${slug}/screen` : `/t/${slug}/screen/${s.screen_key}`;
          const picked = selected.includes(s.screen_key);
          return (
            <div key={s.id} className={`card space-y-2 ${picked ? "border-accent" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-bold">{screenLabel(s)}</p>
                  <p className="truncate text-xs text-muted">
                    {coverageLabel(s, courts)} ·{" "}
                    {isLiveMode(s.display_mode) ? "live" : s.display_mode}
                    {s.focus_court_id
                      ? ` · pinned to ${courts.find((c) => c.id === s.focus_court_id)?.court_name ?? "a removed court"}`
                      : " · following live"}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-1 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={picked}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, s.screen_key] : prev.filter((k) => k !== s.screen_key),
                      )
                    }
                    className="h-4 w-4"
                  />
                  Select
                </label>
              </div>

              <div className="relative overflow-hidden rounded-xl border border-border bg-black">
                {publicAccess ? (
                  <div className="h-[270px] w-full overflow-hidden">
                    <iframe
                      // Keyed by the screen, with a src that never changes, so
                      // the frame is not reloaded on every render of this page.
                      // `allow-same-origin` is required: without it the framed
                      // app cannot refresh itself and the thumbnail silently
                      // freezes while still looking live.
                      key={s.id}
                      src={`${url}?preview=1`}
                      title={`${screenLabel(s)} preview`}
                      sandbox="allow-scripts allow-same-origin"
                      tabIndex={-1}
                      className="pointer-events-none block origin-top-left border-0"
                      style={{ width: 1280, height: 720, transform: "scale(0.375)" }}
                    />
                  </div>
                ) : (
                  <div className="flex h-[270px] items-center justify-center px-4 text-center text-xs text-muted">
                    Preview unavailable while public access is off.
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/operator/tournaments/${tournamentId}/control/${s.screen_key}`} className="btn-primary px-3 py-1 text-xs">
                  Control this screen
                </Link>
                <a href={url} target="_blank" rel="noreferrer" className="btn-secondary px-3 py-1 text-xs">
                  Open ↗
                </a>
                <code className="truncate text-[11px] text-muted">{url}</code>
              </div>
            </div>
          );
        })}
      </div>

      {/* ---------------- Add a screen ---------------- */}
      {canManage && (
        <form action={add} className="card flex flex-wrap items-end gap-2">
          <input type="hidden" name="tournament_id" value={tournamentId} />
          <div className="min-w-48 flex-1">
            <label className="label">Add a screen</label>
            <input name="screen_name" placeholder="TV 2, Lobby, Stream…" className="input" required />
          </div>
          <button className="btn-primary" disabled={adding}>
            {adding ? "Adding…" : "Add screen"}
          </button>
          {addState && (
            <p className={`w-full text-xs font-semibold ${addState.ok ? "text-success" : "text-danger"}`}>
              {addState.message}
            </p>
          )}
          <p className="w-full text-xs text-muted">
            The name becomes the link and cannot change afterwards, because a TV may already be open
            on it. Renaming later changes the label only.
          </p>
        </form>
      )}
    </div>
  );
}
