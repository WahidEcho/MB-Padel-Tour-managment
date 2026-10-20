/**
 * Lining the plan up with the world from surveyed reference spots: the
 * organiser stands at a few places that are on the plan (a gate, a court
 * corner), saves each spot in Survey mode as "align", and the plan's anchor,
 * rotation (and, with three or more spots, optionally its scale) are fitted to
 * them by least squares (a 2D similarity). Pure.
 */
import { enToGeo, geoToEN } from "./geo";
import type { Pt, VenueGeo } from "./types";

export interface AlignPair {
  plan: Pt;
  lat: number;
  lng: number;
  /** Metres; better fixes weigh more. */
  accuracy?: number;
}

export interface Fit {
  geo: VenueGeo;
  /** Root-mean-square distance (metres) between the spots and where the fitted plan puts them. */
  rms: number;
}

export function fitGeo(geo: VenueGeo, pairs: AlignPair[], opts: { fitScale?: boolean } = {}): Fit | null {
  if (!pairs.length) return null;
  // World positions as east/north metres from the current anchor; plan positions in metres.
  const s0 = geo.scale || 1;
  const z = pairs.map((p) => ({ x: p.plan.x * s0, y: p.plan.y * s0 }));
  const w = pairs.map((p) => {
    const { e, n } = geoToEN(geo, p.lat, p.lng);
    return { x: e, y: n };
  });
  const wt = pairs.map((p) => 1 / Math.max(1, p.accuracy ?? 5) ** 2);
  const W = wt.reduce((a, b) => a + b, 0);
  const mean = (v: Pt[]) => ({ x: v.reduce((s, p, i) => s + p.x * wt[i], 0) / W, y: v.reduce((s, p, i) => s + p.y * wt[i], 0) / W });
  const zm = mean(z);
  const wm = mean(w);
  // a = Σ (w - w̄)·conj(z - z̄) / Σ |z - z̄|²  (complex numbers)
  let re = 0;
  let im = 0;
  let zz = 0;
  for (let i = 0; i < z.length; i++) {
    const zx = z[i].x - zm.x;
    const zy = z[i].y - zm.y;
    const wx = w[i].x - wm.x;
    const wy = w[i].y - wm.y;
    re += wt[i] * (wx * zx + wy * zy);
    im += wt[i] * (wy * zx - wx * zy);
    zz += wt[i] * (zx * zx + zy * zy);
  }
  // world = s·e^{-i·rot}·plan + c (src/lib/venue/geo.ts localToGeo)
  let rot = (geo.rotationDeg * Math.PI) / 180;
  let k = 1;
  if (pairs.length >= 2 && zz > 1) {
    rot = -Math.atan2(im, re);
    if (opts.fitScale && pairs.length >= 3) k = Math.hypot(re, im) / zz;
  }
  const cos = Math.cos(-rot) * k;
  const sin = Math.sin(-rot) * k;
  const c = { x: wm.x - (cos * zm.x - sin * zm.y), y: wm.y - (sin * zm.x + cos * zm.y) };
  const anchor = enToGeo(geo, c.x, c.y);
  const fitted: VenueGeo = {
    lat: Math.round(anchor.lat * 1e7) / 1e7,
    lng: Math.round(anchor.lng * 1e7) / 1e7,
    rotationDeg: Math.round((((rot * 180) / Math.PI) % 360 + 360) % 360 * 1000) / 1000,
    scale: Math.round(s0 * k * 1e6) / 1e6,
  };
  let se = 0;
  for (let i = 0; i < z.length; i++) {
    const px = cos * z[i].x - sin * z[i].y + c.x;
    const py = sin * z[i].x + cos * z[i].y + c.y;
    se += (px - w[i].x) ** 2 + (py - w[i].y) ** 2;
  }
  return { geo: fitted, rms: Math.sqrt(se / z.length) };
}

/**
 * The mean of a few seconds of fixes, weighted by accuracy, and its accuracy
 * (never better than the best single fix's). Pure; Survey mode's "Save this spot".
 */
export function averageFixes(fixes: { lat: number; lng: number; accuracy: number }[]): { lat: number; lng: number; accuracy: number; samples: number } | null {
  const good = fixes.filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng) && f.accuracy > 0 && f.accuracy < 200);
  if (!good.length) return null;
  const wts = good.map((f) => 1 / f.accuracy ** 2);
  const W = wts.reduce((a, b) => a + b, 0);
  const lat = good.reduce((s, f, i) => s + f.lat * wts[i], 0) / W;
  const lng = good.reduce((s, f, i) => s + f.lng * wts[i], 0) / W;
  const best = Math.min(...good.map((f) => f.accuracy));
  // Independent errors shrink with √(Σw); real GPS errors are correlated, so keep a floor.
  const combined = 1 / Math.sqrt(W);
  return { lat, lng, accuracy: Math.round(Math.max(combined, best * 0.6) * 10) / 10, samples: good.length };
}
