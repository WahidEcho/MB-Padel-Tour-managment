"use client";

import { useState } from "react";
import StateForm from "@/components/StateForm";
import { COURT_TV_OPACITY, COURT_TV_PALETTES, MAX_HEADER_PARTNERS, type CourtTvSettings, type HeaderPartner } from "@/lib/tennis/courtTv";
import { saveCourtTv } from "./actions";

const SWITCHES: [keyof CourtTvSettings, string, string, string][] = [
  ["glass", "glass", "Glass card", "The score card lets the event background through, blurred."],
  ["breakAnimation", "break_animation", "Break animation", "A slow sweep and a breathing ring behind a break. Still when the screen is muted or asks for reduced motion."],
  ["breakTimer", "break_timer", "Break timer", "The countdown on a changeover, set break, warm-up or medical time-out, and the 25-second shot clock."],
  ["breakLegend", "break_legend", "Show official break times", "25 s · 90 s · 120 s · 5 min · 3 min under the score; the running break is highlighted."],
  ["postMatchStats", "post_match_stats", "Post-match analytics", "When a rubber ends: this match's stats beside the tie and each player's record at the event."],
];

/**
 * The court TV design of a team competition (one court per wall). Breaks show
 * only what the referee's console records; the switches choose how they look.
 */
export default function CourtTvForm({
  tournamentId,
  settings,
  eventLogoLightUrl,
  partners,
}: {
  tournamentId: string;
  settings: CourtTvSettings;
  eventLogoLightUrl: string;
  partners: HeaderPartner[];
}) {
  const [opacity, setOpacity] = useState(settings.glassOpacity);
  const rows = Array.from({ length: MAX_HEADER_PARTNERS }, (_, i) => partners[i] ?? null);
  return (
    <StateForm action={saveCourtTv} className="card space-y-3" testId="court-tv-form">
      <input type="hidden" name="tournament_id" value={tournamentId} />
      <div>
        <h2 className="text-lg font-bold">Court TV design</h2>
        <p className="text-sm text-muted">
          For a team competition&apos;s court TV (a screen showing one court). Light or dark follows each screen&apos;s theme.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {SWITCHES.map(([key, name, label, hint]) => (
          <div key={key}>
            <input type="hidden" name={name} value="off" />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name={name} value="on" defaultChecked={settings[key] as boolean} className="mt-0.5 h-4 w-4" data-testid={`court-tv-${name}`} />
              <span>
                <b>{label}</b>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </label>
          </div>
        ))}
        <label className="block text-sm">
          <span className="label">Glass opacity: {opacity}%</span>
          <input
            type="range"
            name="glass_opacity"
            min={COURT_TV_OPACITY.min}
            max={COURT_TV_OPACITY.max}
            step={COURT_TV_OPACITY.step}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="block text-sm">
          <span className="label">Colours</span>
          <select name="palette" defaultValue={settings.palette} className="input">
            {COURT_TV_PALETTES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm">
        <span className="label">Event logo for light screens (a dark logo; the settings page&apos;s event logo shows on dark screens)</span>
        <input name="event_logo_light_url" defaultValue={eventLogoLightUrl} placeholder="/sponsors/cairo-2026/dark/davis-cup-event.png" className="input" />
      </label>
      <fieldset className="space-y-2 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm font-bold">Partner logos at the top left of the court TV</legend>
        <p className="text-xs text-muted">A site path (/sponsors/…) or an https link. The first logo shows on dark screens, the second (optional) on light ones. Aspect = width ÷ height; height = pixels tall on the 1920×1080 screen (48 when empty).</p>
        {rows.map((p, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_2fr_2fr_70px_70px]">
            <input name={`partner_name_${i}`} defaultValue={p?.name ?? ""} placeholder="Name" className="input text-sm" maxLength={60} />
            <input name={`partner_logo_${i}`} defaultValue={p?.logoUrl ?? ""} placeholder="Logo for dark screens" className="input text-sm" />
            <input name={`partner_light_${i}`} defaultValue={p?.logoLightUrl ?? ""} placeholder="Logo for light screens" className="input text-sm" />
            <input name={`partner_aspect_${i}`} defaultValue={p?.aspect ?? ""} placeholder="Aspect" title="Width ÷ height" className="input text-sm" inputMode="decimal" />
            <input name={`partner_height_${i}`} defaultValue={p?.height ?? ""} placeholder="Height" title="Pixels tall on the 1920×1080 screen (48 when empty)" className="input text-sm" inputMode="numeric" />
          </div>
        ))}
      </fieldset>
      <button className="btn-primary">Save court TV</button>
    </StateForm>
  );
}
