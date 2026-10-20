/**
 * The venue as triangles for the map's WebGL renderer: ground, walkways,
 * courts (surface, run-off, lines, net, fence), buildings and stands, in the
 * light or dark theme. Pure: plain typed arrays, no WebGL here, so it is unit
 * tested and could feed any renderer (expo-gl included).
 *
 * World axes as in camera.ts: X = plan x, Y = up, Z = −plan y.
 */
import { courtPolygon, polygonArea, rotate } from "./geo";
import type { Pt, VenueBuilding, VenueCourt, VenueDoc } from "./types";

export interface Theme {
  scheme: "light" | "dark";
  sky: string;
  ground: string;
  grass: string;
  walkway: string;
  runoff: string;
  line: string;
  net: string;
  fence: string;
  wall: string;
  roof: string;
  stand: string;
  area: string;
  accent: string;
  route: string;
  routeGlow: string;
  label: string;
  labelInk: string;
}

export const VENUE_THEMES: Record<"light" | "dark", Theme> = {
  light: {
    scheme: "light",
    sky: "#e9eef5",
    ground: "#d9dfe6",
    grass: "#cfe3c4",
    walkway: "#f6f4ef",
    runoff: "#4c7a5a",
    line: "#ffffff",
    net: "#2b2f36",
    fence: "#2d4a3a",
    wall: "#c9ced6",
    roof: "#eef1f5",
    stand: "#9aa7b8",
    area: "#b9c0c9",
    accent: "#ff3b5c",
    route: "#1a73e8",
    routeGlow: "#4d9bff",
    label: "#ffffff",
    labelInk: "#0b1220",
  },
  dark: {
    scheme: "dark",
    sky: "#050816",
    ground: "#0c1222",
    grass: "#0f2119",
    walkway: "#2a3247",
    runoff: "#163326",
    line: "#d9e2ef",
    net: "#e8ecf4",
    fence: "#0a1f16",
    wall: "#2b3550",
    roof: "#3a4666",
    stand: "#475572",
    area: "#1a2132",
    accent: "#ff4d6d",
    route: "#4d9bff",
    routeGlow: "#7ab8ff",
    label: "#0a1022",
    labelInk: "#e8ecf4",
  },
};

export function rgb(hex: string): [number, number, number] {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? "808080";
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

export function shade(c: [number, number, number], k: number): [number, number, number] {
  return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
}

/** Ear clipping: triangle indices of a simple polygon (either winding). */
export function triangulate(poly: Pt[]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = [...Array(n).keys()];
  if (polygonArea(poly) < 0) idx.reverse();
  const out: number[] = [];
  const isEar = (i: number, list: number[]) => {
    const a = poly[list[(i + list.length - 1) % list.length]];
    const b = poly[list[i]];
    const c = poly[list[(i + 1) % list.length]];
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) <= 1e-9) return false;
    for (const j of list) {
      const p = poly[j];
      if (p === a || p === b || p === c) continue;
      const d1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const d2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
      const d3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
      if (d1 >= 0 && d2 >= 0 && d3 >= 0) return false;
    }
    return true;
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 10_000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      if (isEar(i, idx)) {
        out.push(idx[(i + idx.length - 1) % idx.length], idx[i], idx[(i + 1) % idx.length]);
        idx.splice(i, 1);
        cut = true;
        break;
      }
    }
    if (!cut) break; // degenerate: fan the rest
  }
  for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1]);
  return out;
}

/** Triangles with a position, a normal and a colour per vertex. */
export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];

  tri(a: [number, number, number], b: [number, number, number], c: [number, number, number], color: [number, number, number], n?: [number, number, number]) {
    let nn = n;
    if (!nn) {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const x = u[1] * v[2] - u[2] * v[1];
      const y = u[2] * v[0] - u[0] * v[2];
      const z = u[0] * v[1] - u[1] * v[0];
      const l = Math.hypot(x, y, z) || 1;
      nn = [x / l, y / l, z / l];
    }
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nn[0], nn[1], nn[2]);
      this.col.push(color[0], color[1], color[2]);
    }
  }

  /** A flat polygon at height h (facing up). */
  flat(poly: Pt[], h: number, color: [number, number, number]) {
    const t = triangulate(poly);
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [poly[t[i]], poly[t[i + 1]], poly[t[i + 2]]];
      // Counter-clockwise in the plan is clockwise seen from above in world (Z = −y): order a, c, b faces up.
      this.tri([a.x, h, -a.y], [c.x, h, -c.y], [b.x, h, -b.y], color, [0, 1, 0]);
    }
  }

  /** A prism: walls from h0 to h1 and a roof. */
  prism(poly: Pt[], h0: number, h1: number, wall: [number, number, number], roof: [number, number, number]) {
    const ccw = polygonArea(poly) >= 0 ? poly : [...poly].reverse();
    for (let i = 0; i < ccw.length; i++) {
      const a = ccw[i];
      const b = ccw[(i + 1) % ccw.length];
      // Light the walls a little by orientation so the shape reads without a shadow pass.
      const k = 0.82 + 0.18 * Math.abs(Math.cos(Math.atan2(b.y - a.y, b.x - a.x) - 0.6));
      const c = shade(wall, k);
      this.tri([a.x, h0, -a.y], [b.x, h0, -b.y], [b.x, h1, -b.y], c);
      this.tri([a.x, h0, -a.y], [b.x, h1, -b.y], [a.x, h1, -a.y], c);
    }
    this.flat(ccw, h1, roof);
  }

  /** A thin box along a segment (fences, the net, lines raised a hair). */
  bar(a: Pt, b: Pt, width: number, h0: number, h1: number, color: [number, number, number]) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * (width / 2);
    const ny = (dx / l) * (width / 2);
    const poly = [
      { x: a.x - nx, y: a.y - ny },
      { x: b.x - nx, y: b.y - ny },
      { x: b.x + nx, y: b.y + ny },
      { x: a.x + nx, y: a.y + ny },
    ];
    if (h1 - h0 < 0.02) this.flat(poly, h1, color);
    else this.prism(poly, h0, h1, color, shade(color, 1.1));
  }

  disc(c: Pt, r: number, h: number, color: [number, number, number], n = 12) {
    const poly = [...Array(n).keys()].map((i) => ({ x: c.x + r * Math.cos((i / n) * Math.PI * 2), y: c.y + r * Math.sin((i / n) * Math.PI * 2) }));
    this.flat(poly, h, color);
  }

  arrays() {
    return { position: new Float32Array(this.pos), normal: new Float32Array(this.nor), color: new Float32Array(this.col), count: this.pos.length / 3 };
  }
}

/** Tennis court markings in court-local metres (doubles 10.97 × 23.77). */
function courtLines(c: Pick<VenueCourt, "center" | "angleDeg">): [Pt, Pt][] {
  const W = 10.97 / 2;
  const S = 8.23 / 2;
  const L = 23.77 / 2;
  const SV = 6.4;
  const seg = (x0: number, y0: number, x1: number, y1: number): [Pt, Pt] => [
    rotate({ x: c.center.x + x0, y: c.center.y + y0 }, c.angleDeg, c.center),
    rotate({ x: c.center.x + x1, y: c.center.y + y1 }, c.angleDeg, c.center),
  ];
  return [
    seg(-W, -L, W, -L),
    seg(-W, L, W, L),
    seg(-W, -L, -W, L),
    seg(W, -L, W, L),
    seg(-S, -L, -S, L),
    seg(S, -L, S, L),
    seg(-S, -SV, S, -SV),
    seg(-S, SV, S, SV),
    seg(0, -SV, 0, SV),
    seg(0, -L, 0, -L + 0.3),
    seg(0, L, 0, L - 0.3),
  ];
}

export const COURT_SLAB = 0.12;

export function eventColor(doc: Pick<VenueDoc, "events">, key: string | null): string {
  return doc.events.find((e) => e.key === key)?.color ?? "#3e8e7e";
}

export function buildCourt(m: MeshBuilder, doc: Pick<VenueDoc, "events">, c: VenueCourt, theme: Theme) {
  const outer = courtPolygon(c);
  const surface = rgb(eventColor(doc, c.event));
  // Run-off: the event colour, darker; the court itself: the event colour.
  m.prism(outer, 0, COURT_SLAB, shade(rgb(theme.runoff), 0.9), shade(surface, theme.scheme === "dark" ? 0.55 : 0.72));
  const inner = courtPolygon({ center: c.center, width: 10.97 + 0.6, length: 23.77 + 0.6, angleDeg: c.angleDeg });
  m.flat(inner, COURT_SLAB + 0.01, surface);
  const line = rgb(theme.line);
  for (const [a, b] of courtLines(c)) m.bar(a, b, 0.1, COURT_SLAB + 0.02, COURT_SLAB + 0.02, line);
  // The net across the middle.
  const n0 = rotate({ x: c.center.x - 6.4, y: c.center.y }, c.angleDeg, c.center);
  const n1 = rotate({ x: c.center.x + 6.4, y: c.center.y }, c.angleDeg, c.center);
  m.bar(n0, n1, 0.06, COURT_SLAB, COURT_SLAB + 0.95, rgb(theme.net));
  // A low fence round the run-off.
  const fence = rgb(theme.fence);
  for (let i = 0; i < outer.length; i++) m.bar(outer[i], outer[(i + 1) % outer.length], 0.08, COURT_SLAB, 1.4, fence);
}

export function buildBuilding(m: MeshBuilder, b: VenueBuilding, theme: Theme) {
  if (b.kind === "area") {
    m.flat(b.polygon, 0.04, rgb(theme.area));
    return;
  }
  if (b.kind === "stand") {
    // Three tiers stepping up away from the court-facing edge (the longest side nearest the centre is fine for a sketch).
    const tiers = 3;
    const poly = polygonArea(b.polygon) >= 0 ? b.polygon : [...b.polygon].reverse();
    for (let i = 0; i < tiers; i++) {
      const k0 = i / tiers;
      const k1 = (i + 1) / tiers;
      const lerp = (p: Pt, q: Pt, k: number) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
      // Steps across the shorter dimension, between edges 0–1 and 3–2.
      const strip = [lerp(poly[0], poly[1], k0), lerp(poly[0], poly[1], k1), lerp(poly[3], poly[2], k1), lerp(poly[3], poly[2], k0)];
      m.prism(strip, 0, (b.height * (tiers - i)) / tiers, rgb(theme.stand), shade(rgb(theme.stand), 1.15));
    }
    return;
  }
  if (b.kind === "canopy") {
    m.prism(b.polygon, b.height - 0.3, b.height, rgb(theme.wall), rgb(theme.roof));
    return;
  }
  m.prism(b.polygon, 0, b.height, rgb(theme.wall), rgb(theme.roof));
}

export const WALKWAY_WIDTH = 3.2;

export function buildScene(doc: Pick<VenueDoc, "boundary" | "buildings" | "courts" | "walkways" | "events">, theme: Theme) {
  const m = new MeshBuilder();
  const all = [...doc.courts.flatMap((c) => courtPolygon(c)), ...doc.buildings.flatMap((b) => b.polygon), ...doc.walkways.nodes];
  const pad = 40;
  const minX = Math.min(...all.map((p) => p.x)) - pad;
  const maxX = Math.max(...all.map((p) => p.x)) + pad;
  const minY = Math.min(...all.map((p) => p.y)) - pad;
  const maxY = Math.max(...all.map((p) => p.y)) + pad;
  // Surroundings, then the site's grass inside its boundary.
  const big = 600;
  m.flat(
    [
      { x: minX - big, y: minY - big },
      { x: maxX + big, y: minY - big },
      { x: maxX + big, y: maxY + big },
      { x: minX - big, y: maxY + big },
    ],
    -0.05,
    rgb(theme.ground),
  );
  const site = doc.boundary && doc.boundary.length >= 3 ? doc.boundary : [
    { x: minX + pad / 2, y: minY + pad / 2 },
    { x: maxX - pad / 2, y: minY + pad / 2 },
    { x: maxX - pad / 2, y: maxY - pad / 2 },
    { x: minX + pad / 2, y: maxY - pad / 2 },
  ];
  m.flat(site, 0, rgb(theme.grass));
  for (const b of doc.buildings) if (b.kind === "area") buildBuilding(m, b, theme);
  // Walkways: a strip per edge and a disc at each node to round the joins.
  const nodes = new Map(doc.walkways.nodes.map((n) => [n.id, n]));
  const walk = rgb(theme.walkway);
  for (const e of doc.walkways.edges) {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (a && b) m.bar(a, b, WALKWAY_WIDTH, 0.06, 0.06, walk);
  }
  for (const n of doc.walkways.nodes) m.disc(n, WALKWAY_WIDTH / 2, 0.06, walk, 10);
  for (const c of doc.courts) buildCourt(m, doc, c, theme);
  for (const b of doc.buildings) if (b.kind !== "area") buildBuilding(m, b, theme);
  return { ...m.arrays(), bounds: { minX: minX + pad, minY: minY + pad, maxX: maxX - pad, maxY: maxY - pad } };
}

/**
 * A ribbon along a polyline for the route: per vertex its position, the
 * distance along the route (for the moving glow) and the side (−1 … 1).
 */
export function ribbon(points: Pt[], width: number, h: number): { position: Float32Array; along: Float32Array; side: Float32Array; count: number } {
  const pos: number[] = [];
  const along: number[] = [];
  const side: number[] = [];
  let d = 0;
  const push = (p: Pt, nx: number, ny: number, s: number, dd: number) => {
    pos.push(p.x + nx * s, h, -(p.y + ny * s));
    along.push(dd);
    side.push(s > 0 ? 1 : -1);
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l < 1e-6) continue;
    const nx = -(b.y - a.y) / l;
    const ny = (b.x - a.x) / l;
    const w = width / 2;
    const d1 = d + l;
    // Two triangles per segment.
    push(a, nx, ny, -w, d);
    push(b, nx, ny, -w, d1);
    push(b, nx, ny, w, d1);
    push(a, nx, ny, -w, d);
    push(b, nx, ny, w, d1);
    push(a, nx, ny, w, d);
    // A round-ish joint at b (a fan of the ribbon's width).
    if (i < points.length - 1) {
      const k = 8;
      for (let j = 0; j < k; j++) {
        const t0 = (j / k) * Math.PI * 2;
        const t1 = ((j + 1) / k) * Math.PI * 2;
        pos.push(b.x, h, -b.y, b.x + Math.cos(t0) * w, h, -(b.y + Math.sin(t0) * w), b.x + Math.cos(t1) * w, h, -(b.y + Math.sin(t1) * w));
        along.push(d1, d1, d1);
        side.push(0, 1, 1);
      }
    }
    d = d1;
  }
  return { position: new Float32Array(pos), along: new Float32Array(along), side: new Float32Array(side), count: pos.length / 3 };
}

/** A flat ring (accuracy circle edge, the streamed courts' halo) as triangles. */
export function ring(c: Pt, r0: number, r1: number, h: number, n = 48): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const p = (r: number, a: number) => [c.x + r * Math.cos(a), h, -(c.y + r * Math.sin(a))];
    out.push(...p(r0, a0), ...p(r1, a0), ...p(r1, a1), ...p(r0, a0), ...p(r1, a1), ...p(r0, a1));
  }
  return new Float32Array(out);
}

/** A rectangle outline (polygon) as a flat band, for highlights. */
export function outline(poly: Pt[], width: number, h: number): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / l) * (width / 2);
    const ny = ((b.x - a.x) / l) * (width / 2);
    const q = [
      [a.x - nx, a.y - ny],
      [b.x - nx, b.y - ny],
      [b.x + nx, b.y + ny],
      [a.x + nx, a.y + ny],
    ].map(([x, y]) => [x, h, -y]);
    out.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
  }
  return new Float32Array(out);
}

/** The phone's heading as a wedge (a cone of light ahead of the blue dot). */
export function wedge(c: Pt, angle: number, r: number, spread: number, h: number, n = 10): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = angle - spread / 2 + (spread * i) / n;
    const a1 = angle - spread / 2 + (spread * (i + 1)) / n;
    out.push(c.x, h, -c.y, c.x + r * Math.cos(a0), h, -(c.y + r * Math.sin(a0)), c.x + r * Math.cos(a1), h, -(c.y + r * Math.sin(a1)));
  }
  return new Float32Array(out);
}
