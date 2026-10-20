/**
 * Geo ↔ plan conversion and plane geometry for the venue map. Pure.
 *
 * A venue is a few hundred metres across, so a local equirectangular projection
 * around the anchor is accurate to millimetres: east/north metres from the
 * anchor, then the plan's rotation and scale.
 */
import type { Pt, VenueCourt, VenueGeo } from "./types";

export const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** East/north metres of (lat, lng) from the anchor. */
export function geoToEN(geo: Pick<VenueGeo, "lat" | "lng">, lat: number, lng: number): { e: number; n: number } {
  const n = (lat - geo.lat) * RAD * EARTH_RADIUS_M;
  const e = (lng - geo.lng) * RAD * EARTH_RADIUS_M * Math.cos(geo.lat * RAD);
  return { e, n };
}

export function enToGeo(geo: Pick<VenueGeo, "lat" | "lng">, e: number, n: number): { lat: number; lng: number } {
  return {
    lat: geo.lat + n / EARTH_RADIUS_M / RAD,
    lng: geo.lng + e / (EARTH_RADIUS_M * Math.cos(geo.lat * RAD)) / RAD,
  };
}

/** A world position on the plan. */
export function geoToLocal(geo: VenueGeo, lat: number, lng: number): Pt {
  const { e, n } = geoToEN(geo, lat, lng);
  const t = geo.rotationDeg * RAD;
  // The plan's +y points t clockwise from north; its +x points t clockwise from east.
  const x = e * Math.cos(t) - n * Math.sin(t);
  const y = e * Math.sin(t) + n * Math.cos(t);
  const s = geo.scale || 1;
  return { x: x / s, y: y / s };
}

/** A plan position in the world. */
export function localToGeo(geo: VenueGeo, p: Pt): { lat: number; lng: number } {
  const s = geo.scale || 1;
  const x = p.x * s;
  const y = p.y * s;
  const t = geo.rotationDeg * RAD;
  const e = x * Math.cos(t) + y * Math.sin(t);
  const n = -x * Math.sin(t) + y * Math.cos(t);
  return enToGeo(geo, e, n);
}

/** Great-circle distance in metres. */
export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A compass heading (degrees clockwise from true north) as a plan angle (radians counter-clockwise from +x). */
export function headingToPlanAngle(geo: VenueGeo, headingDeg: number): number {
  return (90 - (headingDeg - geo.rotationDeg)) * RAD;
}

/* ---------------- plane geometry ---------------- */

export const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** The closest point to p on segment ab, with t ∈ [0, 1] along it. */
export function closestOnSegment(p: Pt, a: Pt, b: Pt): { point: Pt; t: number; distance: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const point = { x: a.x + dx * t, y: a.y + dy * t };
  return { point, t, distance: dist(p, point) };
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Whether segments ab and cd cross at a point inside both (touching ends do not count). */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  const eps = 1e-9;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

/**
 * Whether a walkway segment goes through a polygon (a court's fence, a wall):
 * it crosses an edge, or a point well inside the segment lies inside.
 */
export function segmentEntersPolygon(a: Pt, b: Pt, poly: Pt[]): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (segmentsCross(a, b, poly[j], poly[i])) return true;
  for (const t of [0.25, 0.5, 0.75]) {
    if (pointInPolygon({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, poly)) return true;
  }
  return false;
}

/** Signed area (positive counter-clockwise). */
export function polygonArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return -s / 2;
}

export function centroid(poly: Pt[]): Pt {
  const n = poly.length || 1;
  return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
}

/** Rotates p by `deg` counter-clockwise about c. */
export function rotate(p: Pt, deg: number, c: Pt = { x: 0, y: 0 }): Pt {
  const t = deg * RAD;
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * Math.cos(t) - dy * Math.sin(t), y: c.y + dx * Math.sin(t) + dy * Math.cos(t) };
}

/** A court's fenced rectangle, counter-clockwise. */
export function courtPolygon(c: Pick<VenueCourt, "center" | "width" | "length" | "angleDeg">): Pt[] {
  const w = c.width / 2;
  const l = c.length / 2;
  return [
    { x: -w, y: -l },
    { x: w, y: -l },
    { x: w, y: l },
    { x: -w, y: l },
  ].map((p) => rotate({ x: c.center.x + p.x, y: c.center.y + p.y }, c.angleDeg, c.center));
}

export function boundsOf(points: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!points.length) return { minX: -50, minY: -50, maxX: 50, maxY: 50 };
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}
