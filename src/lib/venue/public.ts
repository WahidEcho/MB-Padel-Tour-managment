/**
 * What the public map, the app and the route API read: an explicit projection
 * of the venue document, field by field. The editor's underlay and the survey
 * fixes (who stood where, when) never leave the server, and nothing unknown in
 * a stored document can ride along. Pure.
 */
import { normalizeCourtName } from "./route";
import type { PublicVenue, PublicVenueCourt, VenueDoc } from "./types";

export interface CourtRow {
  slug: string;
  id: string;
  court_name: string;
}

/** Each court on the map with the court rows (of the venue's tournaments) that carry its name. */
export function linkCourts(doc: Pick<VenueDoc, "courts">, rows: CourtRow[]): PublicVenueCourt[] {
  const byName = new Map<string, { slug: string; courtId: string }[]>();
  for (const r of rows) {
    const k = normalizeCourtName(r.court_name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push({ slug: r.slug, courtId: r.id });
  }
  return doc.courts.map((c) => ({
    id: c.id,
    number: c.number,
    name: c.name,
    event: c.event,
    center: { x: c.center.x, y: c.center.y },
    width: c.width,
    length: c.length,
    angleDeg: c.angleDeg,
    ...(c.streamed ? { streamed: true } : {}),
    ...(c.surface ? { surface: c.surface } : {}),
    links: byName.get(normalizeCourtName(c.name)) ?? [],
  }));
}

/** The map court a court row is (by its id), for "Show on map". */
export function courtForRow(venue: Pick<PublicVenue, "doc">, courtId: string): PublicVenueCourt | null {
  return venue.doc.courts.find((c) => c.links.some((l) => l.courtId === courtId)) ?? null;
}

export function toPublicVenue(row: { id: string; version: number }, doc: VenueDoc, rows: CourtRow[], slugs: string[]): PublicVenue {
  return {
    id: row.id,
    version: row.version,
    slugs,
    doc: {
      schema: doc.schema,
      name: doc.name,
      ...(doc.sample ? { sample: true } : {}),
      ...(doc.note ? { note: doc.note } : {}),
      geo: { lat: doc.geo.lat, lng: doc.geo.lng, rotationDeg: doc.geo.rotationDeg, scale: doc.geo.scale },
      ...(doc.boundary ? { boundary: doc.boundary.map((p) => ({ x: p.x, y: p.y })) } : {}),
      events: doc.events.map((e) => ({ key: e.key, label: e.label, color: e.color, ...(e.slugs ? { slugs: [...e.slugs] } : {}) })),
      categories: doc.categories.map((c) => ({ key: c.key, label: c.label, icon: c.icon, color: c.color })),
      courts: linkCourts(doc, rows),
      buildings: doc.buildings.map((b) => ({ id: b.id, name: b.name, kind: b.kind, height: b.height, polygon: b.polygon.map((p) => ({ x: p.x, y: p.y })) })),
      walkways: {
        nodes: doc.walkways.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, ...(n.label ? { label: n.label } : {}) })),
        edges: doc.walkways.edges.map((e) => ({ a: e.a, b: e.b, ...(e.kind ? { kind: e.kind } : {}) })),
      },
      pois: doc.pois.map((p) => ({
        id: p.id,
        category: p.category,
        name: p.name,
        point: { x: p.point.x, y: p.point.y },
        ...(p.floor !== undefined ? { floor: p.floor } : {}),
        ...(p.indoor ? { indoor: true } : {}),
        ...(p.main ? { main: true } : {}),
      })),
    },
  };
}

/** Every key the public venue may carry, for the tests and the E2E gate. */
export const PUBLIC_VENUE_KEYS = [
  "id", "version", "slugs", "doc", "schema", "name", "sample", "note", "geo", "lat", "lng", "rotationDeg", "scale", "boundary", "x", "y",
  "events", "key", "label", "color", "categories", "icon", "courts", "number", "event", "center", "width", "length", "angleDeg", "streamed",
  "surface", "links", "slug", "courtId", "buildings", "kind", "height", "polygon", "walkways", "nodes", "edges", "a", "b", "pois", "category",
  "point", "floor", "indoor", "main",
] as const;

/** Keys of an object tree (array indexes skipped). */
export function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  }
  return out;
}
