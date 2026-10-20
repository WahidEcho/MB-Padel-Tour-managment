/**
 * The messages between the Move Score app and the map page it shows in a
 * WebView (/t/<slug>/map?embed=app). The app owns the phone's location and
 * compass (expo-location) and feeds them in; the page asks for them and sends
 * "open this match" / "open this court" out. Pure; both sides parse what they
 * receive with these functions and ignore anything else.
 */

export type ToMap =
  | { type: "location"; lat: number; lng: number; accuracy: number | null; heading: number | null; at: number }
  | { type: "heading"; heading: number }
  | { type: "location-off"; reason: "denied" | "unavailable" | "off" }
  | { type: "theme"; scheme: "light" | "dark" }
  | { type: "focus"; target: string };

export type FromMap =
  | { type: "ready"; version: number }
  | { type: "want-location"; on: boolean }
  | { type: "open-match"; slug: string; matchId: string }
  | { type: "open-tie"; slug: string; tieId: string }
  | { type: "open-court"; slug: string | null; courtId: string | null; name: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const short = (v: unknown, max = 80) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

function obj(raw: unknown): Record<string, unknown> | null {
  let v = raw;
  if (typeof v === "string") {
    if (v.length > 4000) return null;
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseToMap(raw: unknown): ToMap | null {
  const m = obj(raw);
  if (!m) return null;
  switch (m.type) {
    case "location": {
      const lat = num(m.lat);
      const lng = num(m.lng);
      if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
      const acc = num(m.accuracy);
      const heading = num(m.heading);
      return { type: "location", lat, lng, accuracy: acc !== null && acc >= 0 ? acc : null, heading: heading !== null && heading >= 0 ? heading % 360 : null, at: num(m.at) ?? Date.now() };
    }
    case "heading": {
      const h = num(m.heading);
      return h === null || h < 0 ? null : { type: "heading", heading: h % 360 };
    }
    case "location-off":
      return { type: "location-off", reason: m.reason === "denied" || m.reason === "unavailable" ? m.reason : "off" };
    case "theme":
      return m.scheme === "light" || m.scheme === "dark" ? { type: "theme", scheme: m.scheme } : null;
    case "focus": {
      const target = short(m.target);
      return target && /^(court|poi|courtrow):[A-Za-z0-9_-]+$/.test(target) ? { type: "focus", target } : null;
    }
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function parseFromMap(raw: unknown): FromMap | null {
  const m = obj(raw);
  if (!m) return null;
  switch (m.type) {
    case "ready":
      return { type: "ready", version: num(m.version) ?? 0 };
    case "want-location":
      return { type: "want-location", on: m.on === true };
    case "open-match": {
      const slug = short(m.slug, 100);
      const matchId = short(m.matchId, 40);
      return slug && SLUG.test(slug) && matchId && UUID.test(matchId) ? { type: "open-match", slug, matchId } : null;
    }
    case "open-tie": {
      const slug = short(m.slug, 100);
      const tieId = short(m.tieId, 40);
      return slug && SLUG.test(slug) && tieId && UUID.test(tieId) ? { type: "open-tie", slug, tieId } : null;
    }
    case "open-court": {
      const name = short(m.name, 60);
      if (!name) return null;
      const slug = short(m.slug, 100);
      const courtId = short(m.courtId, 40);
      return { type: "open-court", slug: slug && SLUG.test(slug) ? slug : null, courtId: courtId && UUID.test(courtId) ? courtId : null, name };
    }
  }
  return null;
}

/** The map page's URL inside the app. */
export function embeddedMapUrl(site: string, slug: string, opts: { scheme: "light" | "dark"; focus?: string | null }): string {
  const q = new URLSearchParams({ embed: "app", theme: opts.scheme });
  if (opts.focus) q.set("focus", opts.focus);
  return `${site.replace(/\/$/, "")}/t/${encodeURIComponent(slug)}/map?${q.toString()}`;
}
