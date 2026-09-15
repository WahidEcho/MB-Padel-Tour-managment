"use client";

import { useActionState, useState } from "react";
import { resolveSponsors } from "@/lib/sponsors";
import type { BrandingConfig } from "@/lib/types";
import { saveBranding, type BrandingFormState } from "./actions";
import BackgroundUploader from "./BackgroundUploader";

/**
 * Logos, the main sponsor's glow, the footer sponsors and the holding slate.
 *
 * Shared by the tournament settings page and a friendly session's admin page:
 * a session's wall is its backing tournament's wall, so its sponsors live there.
 */
export default function BrandingForm({
  tournamentId,
  branding,
  returnPath,
}: {
  tournamentId: string;
  branding: BrandingConfig;
  /** Re-rendered after a save, when the form is embedded outside settings. */
  returnPath?: string;
}) {
  const [state, action, pending] = useActionState<BrandingFormState, FormData>(saveBranding, null);
  const { main, footer } = resolveSponsors(branding);
  const [accent, setAccent] = useState(main?.accentHex ?? "#00a651");

  return (
    <form action={action} className="card space-y-4">
      <h2 className="font-bold">Branding &amp; sponsors</h2>
      <input type="hidden" name="tournament_id" value={tournamentId} />
      {returnPath && <input type="hidden" name="return_path" value={returnPath} />}

      {(
        [
          ["move_beyond_logo", "Move Beyond logo", branding.moveBeyondLogoUrl],
          ["client_logo", "Client/place logo", branding.clientLogoUrl],
          ["event_logo", "Event logo", branding.eventLogoUrl],
          ["background", "Still picture for the holding slate", branding.backgroundUrl],
        ] as const
      ).map(([field, label, url]) => (
        <div key={field} className="flex items-center gap-3">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={label} className="h-10 w-10 rounded-lg border border-border object-contain" />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted">—</span>
          )}
          <div className="flex-1">
            <label className="label">{label}</label>
            <input type="file" name={field} accept="image/*" className="input text-xs" />
          </div>
        </div>
      ))}

      <BackgroundUploader tournamentId={tournamentId} background={branding.background} returnPath={returnPath} />

      <fieldset className="space-y-3 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm font-bold">Main sponsor — glows behind the TV and the public page</legend>
        <div className="flex items-start gap-3">
          {/* A small picture of the glow, so the colour is chosen by eye. */}
          <div
            className="relative flex h-20 w-36 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#0b0b0b]"
            style={{ background: `radial-gradient(circle at 50% 45%, ${accent}55, #0b0b0b 70%)` }}
          >
            {main ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={main.logoUrl} alt="" className="h-14 w-28 object-contain" style={{ filter: `drop-shadow(0 0 10px ${accent})` }} />
            ) : (
              <span className="text-[10px] text-white/60">No logo yet</span>
            )}
          </div>
          <div className="grid flex-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="label">Name</label>
              <input name="main_name" defaultValue={main?.name ?? ""} className="input" placeholder="Fresh" maxLength={60} />
            </div>
            <div>
              <label className="label">Logo</label>
              <input type="file" name="main_logo" accept="image/*" className="input text-xs" />
            </div>
            <div>
              <label className="label">Glow colour</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  name="main_accent"
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  className="h-9 w-12 rounded border border-border"
                />
                <span className="font-mono text-xs text-muted">{accent}</span>
              </div>
            </div>
            <div>
              <label className="label">Intensity</label>
              <select name="main_intensity" defaultValue={main?.intensity ?? "standard"} className="input">
                <option value="subtle">Subtle</option>
                <option value="standard">Standard</option>
                <option value="vivid">Vivid</option>
              </select>
            </div>
          </div>
        </div>
        <input type="hidden" name="main_dashboard" value="off" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="main_dashboard" value="on" defaultChecked={main?.showOnDashboard !== false} className="h-4 w-4" />
          Also glow behind the public dashboard
        </label>
        {main && (
          <label className="flex items-center gap-2 text-xs text-danger">
            <input type="checkbox" name="main_remove" /> Remove the main sponsor
          </label>
        )}
      </fieldset>

      <fieldset className="space-y-2 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm font-bold">Footer sponsors — loop along the bottom of the TV</legend>
        <input type="hidden" name="sponsor_count" value={footer.length} />
        {footer.map((sp, i) => (
          <div key={sp.logoUrl} className="flex items-center gap-2">
            <input type="hidden" name={`sponsor_url_${i}`} value={sp.logoUrl} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sp.logoUrl} alt="" className="h-8 w-16 rounded border border-border object-contain" />
            <input name={`sponsor_name_${i}`} defaultValue={sp.name} placeholder="Sponsor name" className="input flex-1 text-sm" maxLength={60} />
            <label className="flex items-center gap-1 text-xs text-danger">
              <input type="checkbox" name={`sponsor_remove_${i}`} /> remove
            </label>
          </div>
        ))}
        <div>
          <label className="label">Add logos</label>
          <input type="file" name="sponsor_logos" accept="image/*" multiple className="input text-xs" />
        </div>
        {footer.length > 0 && (
          <label className="flex items-center gap-1 text-xs text-danger">
            <input type="checkbox" name="clear_sponsors" /> clear all footer sponsors
          </label>
        )}
      </fieldset>

      <fieldset className="space-y-2 rounded-xl border border-border p-3" data-testid="red-blue-setting">
        <legend className="px-1 text-sm font-bold">Red and blue teams — for the voice umpire and the screens</legend>
        <input type="hidden" name="red_blue_teams" value="off" />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="red_blue_teams"
            value="on"
            defaultChecked={branding.redBlueTeams === true}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            Call and colour every match as the <b className="text-[#dc2626]">Red team</b> and the{" "}
            <b className="text-[#2563eb]">Blue team</b>
          </span>
        </label>
        <p className="text-xs text-muted">
          The first-listed team of each match is Red, the second Blue. The voice says “Advantage, Red team.” and “Game,
          Blue team. Four games to two, Blue team.” — never team or player names — and the TV court cards and the
          referee&apos;s scoring page mark each side in its colour. Off: the voice says “server” and “receiver”.
        </p>
      </fieldset>

      <fieldset className="space-y-2 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm font-bold">Holding slate — what the TV shows between play</legend>
        <div>
          <label className="label">Title</label>
          <input name="holding_title" defaultValue={branding.holding?.title ?? ""} className="input" placeholder="Tournament name" maxLength={120} />
        </div>
        <div>
          <label className="label">Message</label>
          <input name="holding_message" defaultValue={branding.holding?.message ?? ""} className="input" placeholder="Back shortly" maxLength={200} />
        </div>
        <div className="flex items-center gap-3">
          {branding.holding?.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.holding.imageUrl} alt="" className="h-10 w-16 rounded border border-border object-cover" />
          )}
          <div className="flex-1">
            <label className="label">Picture (defaults to the still picture above)</label>
            <input type="file" name="holding_image" accept="image/*" className="input text-xs" />
          </div>
          {branding.holding?.imageUrl && (
            <label className="flex items-center gap-1 text-xs text-danger">
              <input type="checkbox" name="holding_clear_image" /> clear
            </label>
          )}
        </div>
      </fieldset>

      {state && !state.ok && (
        <ul className="space-y-1 rounded-lg bg-danger/10 p-3 text-sm text-danger" role="alert">
          {state.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {state?.ok && <p className="text-sm font-semibold text-success">{state.message}</p>}
      <button className="btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Save branding"}
      </button>
    </form>
  );
}
