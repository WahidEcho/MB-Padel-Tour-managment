/**
 * Reading a venue document from anywhere (the editor, an imported JSON file):
 * only known fields survive, every number is finite and bounded, every id is
 * a short token, strings are capped. Pure. Also the editor's warnings: courts
 * that link to no court row, walkways through a court, places the walkways do
 * not reach.
 */
import { buildGraph, reachableFrom, snapToGraph } from "./graph";
import { normalizeCourtName, mainEntrance } from "./route";
import type { BuildingKind, PoiCategory, Pt, SurveyFix, VenueBuilding, VenueCourt, VenueDoc, VenueEvent, VenuePoi, WalkEdge, WalkNode } from "./types";
import { VENUE_SCHEMA } from "./types";
import { DEFAULT_CATEGORIES } from "./categories";

export const LIMITS = { courts: 80, buildings: 120, polygon: 80, nodes: 600, edges: 1200, pois: 300, events: 8, categories: 24, extentM: 5000 };

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export interface Parsed {
  ok: boolean;
  doc: VenueDoc | null;
  problems: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function pt(v: unknown): Pt | null {
  if (!isObj(v)) return null;
  const x = num(v.x, -LIMITS.extentM, LIMITS.extentM);
  const y = num(v.y, -LIMITS.extentM, LIMITS.extentM);
  return x === null || y === null ? null : { x: round(x), y: round(y) };
}

function survey(v: unknown): SurveyFix | undefined {
  if (!isObj(v)) return undefined;
  const lat = num(v.lat, -90, 90);
  const lng = num(v.lng, -180, 180);
  const accuracy = num(v.accuracy, 0, 10_000);
  if (lat === null || lng === null || accuracy === null) return undefined;
  return {
    lat: round(lat, 7),
    lng: round(lng, 7),
    accuracy: round(accuracy, 1),
    samples: Math.max(1, Math.min(10_000, Math.round(num(v.samples, 1, 10_000) ?? 1))),
    at: typeof v.at === "string" && !Number.isNaN(Date.parse(v.at)) ? new Date(v.at).toISOString() : new Date(0).toISOString(),
    mode: v.mode === "align" ? "align" : "move",
  };
}

function idOf(v: unknown, problems: string[], what: string, seen: Set<string>): string | null {
  if (typeof v !== "string" || !ID.test(v)) {
    problems.push(`${what}: the id must be 1–40 letters, digits, - or _.`);
    return null;
  }
  if (seen.has(v)) {
    problems.push(`${what}: the id "${v}" is used twice.`);
    return null;
  }
  seen.add(v);
  return v;
}

function list(v: unknown, max: number, what: string, problems: string[]): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    problems.push(`${what} must be a list.`);
    return [];
  }
  if (v.length > max) problems.push(`At most ${max} ${what} (this has ${v.length}).`);
  return v.slice(0, max);
}

export function parseVenue(input: unknown): Parsed {
  const problems: string[] = [];
  if (!isObj(input)) return { ok: false, doc: null, problems: ["That is not a venue document (expected a JSON object)."] };
  if (input.schema !== undefined && input.schema !== VENUE_SCHEMA) problems.push(`Unknown schema ${String(input.schema)} (this server reads schema ${VENUE_SCHEMA}).`);
  const g = isObj(input.geo) ? input.geo : {};
  const lat = num(g.lat, -90, 90);
  const lng = num(g.lng, -180, 180);
  if (lat === null || lng === null) problems.push("geo: lat and lng of the anchor are required (degrees).");
  const geo = {
    lat: round(lat ?? 0, 7),
    lng: round(lng ?? 0, 7),
    rotationDeg: round((((num(g.rotationDeg, -3600, 3600) ?? 0) % 360) + 360) % 360, 3),
    scale: num(g.scale, 0.0001, 1000) ?? 1,
  };

  const events: VenueEvent[] = [];
  const eventKeys = new Set<string>();
  for (const [i, e] of list(input.events, LIMITS.events, "events", problems).entries()) {
    if (!isObj(e)) continue;
    const key = idOf(e.key, problems, `events[${i}]`, eventKeys);
    if (!key) continue;
    const slugs = Array.isArray(e.slugs) ? e.slugs.filter((s): s is string => typeof s === "string" && /^[a-z0-9-]{1,80}$/.test(s)).slice(0, 8) : undefined;
    events.push({ key, label: str(e.label, 60) ?? key, color: typeof e.color === "string" && COLOR.test(e.color) ? e.color : "#3a7bd5", ...(slugs?.length ? { slugs } : {}) });
  }

  const categories: PoiCategory[] = [];
  const catKeys = new Set<string>();
  const rawCats = input.categories === undefined ? DEFAULT_CATEGORIES : input.categories;
  for (const [i, c] of list(rawCats, LIMITS.categories, "categories", problems).entries()) {
    if (!isObj(c)) continue;
    const key = idOf(c.key, problems, `categories[${i}]`, catKeys);
    if (!key) continue;
    categories.push({
      key,
      label: str(c.label, 40) ?? key,
      icon: typeof c.icon === "string" && /^[a-z_]{1,20}$/.test(c.icon) ? c.icon : "pin",
      color: typeof c.color === "string" && COLOR.test(c.color) ? c.color : "#607080",
    });
  }

  const ids = new Set<string>();
  const courts: VenueCourt[] = [];
  for (const [i, c] of list(input.courts, LIMITS.courts, "courts", problems).entries()) {
    if (!isObj(c)) continue;
    const id = idOf(c.id, problems, `courts[${i}]`, ids);
    const center = pt(c.center);
    const name = str(c.name, 40);
    if (!id || !center || !name) {
      if (id && (!center || !name)) problems.push(`Court ${id}: a name and a centre are required.`);
      continue;
    }
    const event = typeof c.event === "string" && eventKeys.has(c.event) ? c.event : null;
    const surface = ["hard", "clay", "grass", "padel"].includes(String(c.surface)) ? (c.surface as VenueCourt["surface"]) : undefined;
    const s = survey(c.survey);
    courts.push({
      id,
      number: Math.round(num(c.number, 0, 999) ?? i + 1),
      name,
      event,
      center,
      width: round(num(c.width, 3, 80) ?? 18),
      length: round(num(c.length, 5, 120) ?? 36),
      angleDeg: round(num(c.angleDeg, -360, 360) ?? 0, 2),
      ...(c.streamed === true ? { streamed: true } : {}),
      ...(surface ? { surface } : {}),
      ...(s ? { survey: s } : {}),
    });
  }

  const buildings: VenueBuilding[] = [];
  for (const [i, b] of list(input.buildings, LIMITS.buildings, "buildings", problems).entries()) {
    if (!isObj(b)) continue;
    const id = idOf(b.id, problems, `buildings[${i}]`, ids);
    const polygon = list(b.polygon, LIMITS.polygon, `points of building ${String(b.id)}`, problems).map(pt).filter((p): p is Pt => p !== null);
    if (!id) continue;
    if (polygon.length < 3) {
      problems.push(`Building ${id}: needs at least 3 corners.`);
      continue;
    }
    const kind: BuildingKind = ["building", "stand", "canopy", "wall", "area"].includes(String(b.kind)) ? (b.kind as BuildingKind) : "building";
    buildings.push({ id, name: str(b.name, 60) ?? id, kind, polygon, height: round(num(b.height, 0.2, 80) ?? (kind === "stand" ? 4 : kind === "wall" ? 2.2 : 6)) });
  }

  const w = isObj(input.walkways) ? input.walkways : {};
  const nodes: WalkNode[] = [];
  const nodeIds = new Set<string>();
  for (const [i, n] of list(w.nodes, LIMITS.nodes, "walkway nodes", problems).entries()) {
    if (!isObj(n)) continue;
    const id = idOf(n.id, problems, `walkways.nodes[${i}]`, nodeIds);
    const p = pt(n);
    if (!id || !p) continue;
    const label = str(n.label, 60);
    const s = survey(n.survey);
    nodes.push({ id, ...p, ...(label ? { label } : {}), ...(s ? { survey: s } : {}) });
  }
  const edges: WalkEdge[] = [];
  for (const e of list(w.edges, LIMITS.edges, "walkway edges", problems)) {
    if (!isObj(e) || typeof e.a !== "string" || typeof e.b !== "string") continue;
    if (!nodeIds.has(e.a) || !nodeIds.has(e.b)) {
      problems.push(`A walkway joins ${String(e.a)} and ${String(e.b)}, but one of them is not a node.`);
      continue;
    }
    if (e.a === e.b) continue;
    const kind = e.kind === "indoor" || e.kind === "stairs" ? e.kind : undefined;
    edges.push({ a: e.a, b: e.b, ...(kind ? { kind } : {}) });
  }

  const pois: VenuePoi[] = [];
  for (const [i, p] of list(input.pois, LIMITS.pois, "points of interest", problems).entries()) {
    if (!isObj(p)) continue;
    const id = idOf(p.id, problems, `pois[${i}]`, ids);
    const point = pt(p.point);
    const name = str(p.name, 60);
    if (!id || !point || !name) continue;
    const category = typeof p.category === "string" && catKeys.has(p.category) ? p.category : null;
    if (!category) {
      problems.push(`${name}: unknown category "${String(p.category)}".`);
      continue;
    }
    const floor = num(p.floor, -5, 50);
    const s = survey(p.survey);
    pois.push({
      id,
      category,
      name,
      point,
      ...(floor !== null ? { floor: Math.round(floor) } : {}),
      ...(p.indoor === true ? { indoor: true } : {}),
      ...(p.main === true ? { main: true } : {}),
      ...(s ? { survey: s } : {}),
    });
  }
  if (pois.filter((p) => p.main).length > 1) problems.push("Only one point can be the main entrance.");

  const boundary = Array.isArray(input.boundary) ? input.boundary.slice(0, LIMITS.polygon).map(pt).filter((p): p is Pt => p !== null) : [];
  const note = str(input.note, 200);
  const doc: VenueDoc = {
    schema: VENUE_SCHEMA,
    name: str(input.name, 120) ?? "Venue",
    ...(input.sample === true ? { sample: true } : {}),
    ...(note ? { note } : {}),
    geo,
    ...(boundary.length >= 3 ? { boundary } : {}),
    events,
    categories,
    courts,
    buildings,
    walkways: { nodes, edges },
    pois,
  };
  return { ok: problems.length === 0, doc, problems };
}

/** Things the organiser should fix before the event (they do not stop a save). */
export function venueWarnings(doc: VenueDoc, courtRows: { slug: string; court_name: string }[] = []): string[] {
  const out: string[] = [];
  const graph = buildGraph(doc);
  for (const b of graph.blocked) out.push(`The walkway ${b.a}–${b.b} goes through ${b.through}; it is left out of routes.`);
  const entrance = mainEntrance(doc);
  if (!entrance) out.push("No main entrance: mark one entrance as main (routes start there when a phone's location is unusable).");
  if (!graph.edges.length) out.push("No walkways yet: routes need walkway lines.");
  else if (entrance) {
    const start = snapToGraph(graph, entrance.point);
    if (start) {
      const e = graph.edges[start.edge];
      const reach = reachableFrom(graph, e.a);
      const unreachable = (p: Pt) => {
        const s = snapToGraph(graph, p);
        return !s || !reach.has(graph.edges[s.edge].a) || s.distance > 40;
      };
      for (const c of doc.courts) if (unreachable(c.center)) out.push(`${c.name} is not reached by the walkways from the ${entrance.name}.`);
      for (const p of doc.pois) if (unreachable(p.point)) out.push(`${p.name} is not reached by the walkways from the ${entrance.name}.`);
    }
  }
  if (courtRows.length) {
    const onMap = new Set(doc.courts.map((c) => normalizeCourtName(c.name)));
    const inEvents = new Set(courtRows.map((r) => normalizeCourtName(r.court_name)));
    for (const c of doc.courts) if (!inEvents.has(normalizeCourtName(c.name))) out.push(`${c.name} on the map is not a court of these events (its live match cannot be shown).`);
    for (const r of courtRows) if (!onMap.has(normalizeCourtName(r.court_name))) out.push(`${r.court_name} (${r.slug}) is not on the map.`);
  }
  const seenNames = new Map<string, number>();
  for (const c of doc.courts) seenNames.set(normalizeCourtName(c.name), (seenNames.get(normalizeCourtName(c.name)) ?? 0) + 1);
  for (const [n, k] of seenNames) if (k > 1) out.push(`Two courts on the map are both called "${n}".`);
  return [...new Set(out)];
}
