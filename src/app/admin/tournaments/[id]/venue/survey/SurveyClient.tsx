"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { averageFixes } from "@/lib/venue/fit";
import { geoToLocal } from "@/lib/venue/geo";
import type { Pt, SurveyFix, VenueGeo } from "@/lib/venue/types";
import type { FormState } from "@/lib/refusal";
import { surveySpotAction } from "../actions";

/** How long "Save this spot" listens (seconds). */
const LISTEN_S = 6;

type Feature = { ref: string; label: string; group: string; point: Pt; survey?: SurveyFix };
type Raw = { lat: number; lng: number; accuracy: number };

export default function SurveyClient({ tournamentId, features, geo, sample }: { tournamentId: string; features: Feature[]; geo: VenueGeo; sample: boolean }) {
  const [feature, setFeature] = useState(features[0]?.ref ?? "");
  const [mode, setMode] = useState<"move" | "align">(sample ? "align" : "move");
  const [fitScale, setFitScale] = useState(false);
  const [now, setNow] = useState<Raw | null>(null);
  const [error, setError] = useState<string | null>(() => (typeof navigator !== "undefined" && !("geolocation" in navigator) ? "This browser has no location." : null));
  const [listening, setListening] = useState(0);
  const [result, setResult] = useState<{ lat: number; lng: number; accuracy: number; samples: number } | null>(null);
  const [msg, setMsg] = useState<FormState>(null);
  const [pending, start] = useTransition();
  const buffer = useRef<Raw[]>([]);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
        setNow(fix);
        setError(null);
        buffer.current.push(fix);
        if (buffer.current.length > 200) buffer.current.shift();
      },
      (e) => setError(e.code === e.PERMISSION_DENIED ? "Location is blocked for this site: allow it in the browser settings." : "No location yet. Step into the open."),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const groups = useMemo(() => [...new Set(features.map((f) => f.group))], [features]);
  const current = features.find((f) => f.ref === feature);
  const offset = now && current ? (() => {
    const p = geoToLocal(geo, now.lat, now.lng);
    return Math.hypot(p.x - current.point.x, p.y - current.point.y);
  })() : null;

  const listen = () => {
    // The fix on screen counts; the next few seconds of fixes join it.
    buffer.current = now ? [now] : [];
    setResult(null);
    setMsg(null);
    setListening(LISTEN_S);
    let left = LISTEN_S;
    const t = setInterval(() => {
      left -= 1;
      setListening(left);
      if (left <= 0) {
        clearInterval(t);
        setResult(averageFixes(buffer.current));
      }
    }, 1000);
  };

  const save = () => {
    if (!result) return;
    const f = new FormData();
    f.set("tournament_id", tournamentId);
    f.set("feature", feature);
    f.set("mode", mode);
    if (fitScale) f.set("fit_scale", "on");
    f.set("lat", String(result.lat));
    f.set("lng", String(result.lng));
    f.set("accuracy", String(result.accuracy));
    f.set("samples", String(result.samples));
    start(async () => {
      const r = await surveySpotAction(null, f);
      setMsg(r);
      if (r?.ok) setResult(null);
    });
  };

  const tone = (a: number) => (a <= 5 ? "text-success" : a <= 12 ? "text-warning" : "text-danger");

  return (
    <div className="space-y-3">
      <section className="card space-y-2 text-sm">
        <label className="block">
          Feature
          <select className="input text-base" value={feature} onChange={(e) => setFeature(e.target.value)} data-testid="survey-feature">
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {features
                  .filter((f) => f.group === g)
                  .map((f) => (
                    <option key={f.ref} value={f.ref}>
                      {f.label}
                      {f.survey ? ` ✓ ±${f.survey.accuracy} m` : ""}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <fieldset className="space-y-1">
          <label className="flex items-start gap-2">
            <input type="radio" checked={mode === "move"} onChange={() => setMode("move")} />
            <span>
              <b>Place it here</b> — the feature moves to where I stand.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" checked={mode === "align"} onChange={() => setMode("align")} />
            <span>
              <b>Reference spot</b> — the plan is right, line the whole plan up with this spot (two or more spots fix the rotation).
            </span>
          </label>
          {mode === "align" && (
            <label className="flex items-center gap-2 pl-6 text-xs">
              <input type="checkbox" checked={fitScale} onChange={(e) => setFitScale(e.target.checked)} /> Also fit the scale (three or more spots; only for a plan not drawn in metres)
            </label>
          )}
        </fieldset>
      </section>

      <section className="card space-y-2 text-center" data-testid="survey-gps">
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : now ? (
          <>
            <p className={`text-3xl font-black ${tone(now.accuracy)}`}>±{now.accuracy.toFixed(0)} m</p>
            <p className="text-xs text-muted">
              {now.lat.toFixed(6)}, {now.lng.toFixed(6)}
              {offset !== null && ` · ${offset.toFixed(0)} m from where the plan has it`}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">Waiting for the phone&apos;s location…</p>
        )}
        <button type="button" className="btn-primary w-full py-4 text-lg" onClick={listen} disabled={!now || listening > 0 || pending} data-testid="survey-save-spot">
          {listening > 0 ? `Hold still… ${listening}` : "Save this spot"}
        </button>
        {result && (
          <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <p>
              Averaged <b>{result.samples}</b> {result.samples === 1 ? "fix" : "fixes"}: <b className={tone(result.accuracy)}>±{result.accuracy} m</b>
            </p>
            <button type="button" className="btn-primary w-full" onClick={save} disabled={pending} data-testid="survey-confirm">
              {pending ? "Saving…" : `Save for ${current?.label ?? "the feature"}`}
            </button>
            <button type="button" className="text-xs underline" onClick={() => setResult(null)}>
              Discard
            </button>
          </div>
        )}
        {msg && (
          <p className={`text-sm font-semibold ${msg.ok ? "text-success" : "text-danger"}`} role="status">
            {msg.message}
          </p>
        )}
      </section>
      <p className="text-xs text-muted">Tip: stand still in the open for a few seconds before saving; under a roof GPS drifts by tens of metres.</p>
    </div>
  );
}
