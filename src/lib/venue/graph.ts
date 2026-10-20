/**
 * The walkway graph and shortest walking routes (A*). Pure.
 *
 * People walk only along the walkway edges the organiser drew. An edge that
 * passes through a court's fence, or through a building without being marked
 * "indoor", is dropped when the graph is built (and listed, so the editor can
 * flag it): a route never cuts across a court.
 *
 * A start or a destination off the graph is snapped to the nearest point of the
 * nearest edge and joined to the graph there.
 */
import { closestOnSegment, courtPolygon, dist, segmentEntersPolygon } from "./geo";
import type { Pt, VenueDoc, WalkEdge } from "./types";

export interface GraphEdge {
  id: number;
  a: string;
  b: string;
  length: number;
}

export interface WalkGraph {
  nodes: Map<string, Pt & { id: string; label?: string }>;
  edges: GraphEdge[];
  adj: Map<string, { to: string; edge: number; length: number }[]>;
  /** Edges left out because they pass through a court or a building. */
  blocked: { a: string; b: string; through: string }[];
}

type GraphSource = Pick<VenueDoc, "walkways" | "courts" | "buildings">;

export function buildGraph(doc: GraphSource): WalkGraph {
  const nodes = new Map(doc.walkways.nodes.map((n) => [n.id, { id: n.id, x: n.x, y: n.y, label: n.label }]));
  const obstacles = [
    ...doc.courts.map((c) => ({ name: c.name, poly: courtPolygon(c), building: false })),
    ...doc.buildings.filter((b) => b.kind !== "canopy" && b.kind !== "area").map((b) => ({ name: b.name, poly: b.polygon, building: true })),
  ];
  const edges: GraphEdge[] = [];
  const blocked: WalkGraph["blocked"] = [];
  const adj = new Map<string, { to: string; edge: number; length: number }[]>();
  const seen = new Set<string>();
  for (const e of doc.walkways.edges as WalkEdge[]) {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (!a || !b || e.a === e.b) continue;
    const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = obstacles.find((o) => !(o.building && e.kind === "indoor") && segmentEntersPolygon(a, b, o.poly));
    if (hit) {
      blocked.push({ a: e.a, b: e.b, through: hit.name });
      continue;
    }
    const edge = { id: edges.length, a: e.a, b: e.b, length: dist(a, b) };
    edges.push(edge);
    for (const [from, to] of [[e.a, e.b], [e.b, e.a]] as const) {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, edge: edge.id, length: edge.length });
    }
  }
  return { nodes, edges, adj, blocked };
}

export interface Snap {
  edge: number;
  /** 0 at the edge's `a` node, 1 at `b`. */
  t: number;
  point: Pt;
  distance: number;
}

/** The nearest point of the graph to p; null for a graph without edges. */
export function snapToGraph(g: WalkGraph, p: Pt): Snap | null {
  let best: Snap | null = null;
  for (const e of g.edges) {
    const c = closestOnSegment(p, g.nodes.get(e.a)!, g.nodes.get(e.b)!);
    if (!best || c.distance < best.distance) best = { edge: e.id, t: c.t, point: c.point, distance: c.distance };
  }
  return best;
}

export interface GraphPath {
  /** From the snapped start to the snapped end. */
  points: Pt[];
  /** Graph nodes passed, in order (labels for directions). */
  nodeIds: string[];
  length: number;
}

const START = "\u0000start";
const END = "\u0000end";

/**
 * The shortest walk between two snapped points (A*, straight-line heuristic).
 * Null when they are on parts of the graph that do not connect.
 */
export function shortestPath(g: WalkGraph, from: Snap, to: Snap): GraphPath | null {
  const ef = g.edges[from.edge];
  const et = g.edges[to.edge];
  // Both on one edge: walk straight along it.
  if (ef.id === et.id) {
    return { points: [from.point, to.point], nodeIds: [], length: dist(from.point, to.point) };
  }
  const pos = (id: string): Pt => (id === START ? from.point : id === END ? to.point : g.nodes.get(id)!);
  const extra = new Map<string, { to: string; length: number }[]>();
  const link = (a: string, b: string, length: number) => {
    if (!extra.has(a)) extra.set(a, []);
    extra.get(a)!.push({ to: b, length });
  };
  link(START, ef.a, ef.length * from.t);
  link(START, ef.b, ef.length * (1 - from.t));
  link(et.a, END, et.length * to.t);
  link(et.b, END, et.length * (1 - to.t));

  const goal = to.point;
  const gScore = new Map<string, number>([[START, 0]]);
  const came = new Map<string, string>();
  const open = new Set<string>([START]);
  const fScore = new Map<string, number>([[START, dist(from.point, goal)]]);
  const closed = new Set<string>();
  while (open.size) {
    let cur = "";
    let bestF = Infinity;
    for (const id of open) {
      const f = fScore.get(id) ?? Infinity;
      if (f < bestF) {
        bestF = f;
        cur = id;
      }
    }
    if (cur === END) break;
    open.delete(cur);
    closed.add(cur);
    const out = [...(g.adj.get(cur) ?? []).map((n) => ({ to: n.to, length: n.length })), ...(extra.get(cur) ?? [])];
    for (const n of out) {
      if (closed.has(n.to)) continue;
      const tentative = (gScore.get(cur) ?? Infinity) + n.length;
      if (tentative < (gScore.get(n.to) ?? Infinity)) {
        came.set(n.to, cur);
        gScore.set(n.to, tentative);
        fScore.set(n.to, tentative + dist(pos(n.to), goal));
        open.add(n.to);
      }
    }
  }
  if (!gScore.has(END)) return null;
  const ids: string[] = [];
  for (let at: string | undefined = END; at; at = came.get(at)) ids.unshift(at);
  const points: Pt[] = [];
  for (const id of ids) {
    const p = pos(id);
    const last = points[points.length - 1];
    if (!last || dist(last, p) > 0.01) points.push(p);
  }
  return { points, nodeIds: ids.filter((id) => id !== START && id !== END), length: gScore.get(END)! };
}

/** The ids of nodes reachable from a node (for the editor's "not connected" warnings). */
export function reachableFrom(g: WalkGraph, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of g.adj.get(cur) ?? []) {
      if (!seen.has(n.to)) {
        seen.add(n.to);
        stack.push(n.to);
      }
    }
  }
  return seen;
}

/** Length of a polyline. */
export function polylineLength(points: Pt[]): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += dist(points[i - 1], points[i]);
  return s;
}
