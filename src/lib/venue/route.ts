/**
 * From where someone stands to a court or a point of interest: the start
 * (their position, or the main entrance when their position is unusable),
 * the destination, the walk along the graph and its directions. Pure.
 */
import { buildGraph, shortestPath, snapToGraph, type WalkGraph } from "./graph";
import { boundsOf, courtPolygon, dist, geoToLocal } from "./geo";
import { directionsFor, type Step } from "./directions";
import type { Pt, VenueDoc } from "./types";

/** "court:<id>" or "poi:<id>". */
export type TargetKey = string;

export interface Target {
  key: TargetKey;
  kind: "court" | "poi";
  id: string;
  name: string;
  /** Where the feature is (a court's centre). */
  point: Pt;
}

type DocLike = Pick<VenueDoc, "courts" | "pois" | "walkways" | "buildings" | "geo">;

export function targetOf(doc: Pick<VenueDoc, "courts" | "pois">, key: TargetKey): Target | null {
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  if (kind === "court") {
    // By feature id, by number ("court:7") or by name.
    const c =
      doc.courts.find((x) => x.id === id) ??
      doc.courts.find((x) => String(x.number) === id) ??
      doc.courts.find((x) => normalizeCourtName(x.name) === normalizeCourtName(id));
    return c ? { key: `court:${c.id}`, kind: "court", id: c.id, name: c.name, point: c.center } : null;
  }
  if (kind === "poi") {
    const p = doc.pois.find((x) => x.id === id);
    return p ? { key: `poi:${p.id}`, kind: "poi", id: p.id, name: p.name, point: p.point } : null;
  }
  return null;
}

/** "Court 07", "court 7" and "7" are the same court. */
export function normalizeCourtName(name: string): string {
  const s = name.toLowerCase().replace(/\s+/g, " ").trim();
  const m = /^(?:court\s*)?0*(\d+)$/.exec(s);
  return m ? m[1] : s;
}

export function mainEntrance(doc: Pick<VenueDoc, "pois">) {
  return doc.pois.find((p) => p.main) ?? doc.pois.find((p) => p.category === "entrance") ?? null;
}

/** Positions further than this from the venue, or less accurate than this, are not used to route. */
export const MAX_START_OFFSET_M = 120;
export const MAX_START_ACCURACY_M = 60;

export type StartReason = "location" | "no_location" | "inaccurate" | "far_away" | "chosen";

export interface RouteStart {
  point: Pt;
  fromEntrance: boolean;
  reason: StartReason;
  /** For the person: "Your location isn't available, so the route starts at the Main Entrance." */
  note: string | null;
}

/**
 * Where a route starts. A fix far outside the venue (at home, at the hotel), a
 * vague one (indoors), or none: the main entrance, and a sentence that says so.
 */
export function routeStart(doc: DocLike, fix: { lat: number; lng: number; accuracy?: number | null } | null): RouteStart | null {
  const entrance = mainEntrance(doc);
  const fallback = (reason: StartReason, note: string): RouteStart | null =>
    entrance ? { point: entrance.point, fromEntrance: true, reason, note: note.replace("{e}", entrance.name) } : null;
  if (!fix) return fallback("no_location", "Your location isn't available, so the route starts at the {e}.");
  if (fix.accuracy != null && fix.accuracy > MAX_START_ACCURACY_M) {
    return fallback("inaccurate", "Your location isn't precise enough here, so the route starts at the {e}.");
  }
  const p = geoToLocal(doc.geo, fix.lat, fix.lng);
  const b = boundsOf(siteOutline(doc));
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  if (Math.hypot(dx, dy) > MAX_START_OFFSET_M) return fallback("far_away", "You're not at the venue yet, so the route starts at the {e}.");
  return { point: p, fromEntrance: false, reason: "location", note: null };
}

function siteOutline(doc: DocLike): Pt[] {
  return [...doc.walkways.nodes, ...doc.pois.map((p) => p.point), ...doc.courts.flatMap((c) => courtPolygon(c))];
}

export interface Route {
  target: Target;
  start: RouteStart;
  points: Pt[];
  /** Metres. */
  length: number;
  seconds: number;
  steps: Step[];
}

/** Walking pace at a busy venue (about 4.3 km/h). */
export const WALK_SPEED_MS = 1.2;

export function walkingSeconds(m: number): number {
  return Math.round(m / WALK_SPEED_MS);
}

/**
 * The walk from `from` to the target. The path starts at the person and ends at
 * the feature (the snapped walkway point, then the court's gate side or the POI).
 */
export function planRoute(doc: DocLike, start: RouteStart, target: Target, graph: WalkGraph = buildGraph(doc as VenueDoc)): Route | null {
  const a = snapToGraph(graph, start.point);
  const b = snapToGraph(graph, target.point);
  if (!a || !b) return null;
  const path = shortestPath(graph, a, b);
  if (!path) return null;
  const points: Pt[] = [];
  const push = (p: Pt) => {
    const last = points[points.length - 1];
    if (!last || dist(last, p) > 0.5) points.push(p);
  };
  if (a.distance > 1) push(start.point);
  path.points.forEach(push);
  // A POI is walked up to; a court is reached at its fence (its centre is the middle of the court).
  if (target.kind === "poi" && b.distance > 1) push(target.point);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += dist(points[i - 1], points[i]);
  const labels = new Map([...graph.nodes.values()].filter((n) => n.label).map((n) => [n.id, n]));
  const landmarks = [
    ...doc.courts.map((c) => ({ name: c.name, point: c.center })),
    ...doc.pois.map((p) => ({ name: p.name, point: p.point })),
    ...[...labels.values()].map((n) => ({ name: n.label!, point: { x: n.x, y: n.y } })),
  ];
  return {
    target,
    start,
    points,
    length,
    seconds: walkingSeconds(length),
    steps: directionsFor(points, target, landmarks),
  };
}
