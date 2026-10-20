/**
 * A small ASCII DXF reader for site plans (the club's AutoCAD layout, saved as
 * DXF): every LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE and SPLINE, block
 * INSERTs expanded, grouped by layer as polylines in drawing units. The editor
 * shows the layers the organiser picks as the underlay to trace courts,
 * buildings and walkways on. Text, hatches and dimensions are skipped. Pure.
 */
import type { VectorLayer } from "./types";

export interface VectorPlan {
  units: string;
  /** Metres per drawing unit, from $INSUNITS (1 when the file does not say). */
  metresPerUnit: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  layers: VectorLayer[];
  /** Entities skipped, by type. */
  skipped: Record<string, number>;
}

const UNITS: Record<number, [string, number]> = {
  0: ["unitless", 1],
  1: ["inches", 0.0254],
  2: ["feet", 0.3048],
  4: ["millimetres", 0.001],
  5: ["centimetres", 0.01],
  6: ["metres", 1],
  14: ["decimetres", 0.1],
};

/** AutoCAD colour index → hex, for the first few (the rest draw grey). */
const ACI: Record<number, string> = { 1: "#e5484d", 2: "#d4b106", 3: "#12a150", 4: "#0e9aa7", 5: "#2f6fd6", 6: "#b5179e", 7: "#6b7280", 8: "#9ca3af", 9: "#c0c4cc" };

export const MAX_PLAN_POINTS = 400_000;

type Pair = [number, string];
type Entity = { type: string; pairs: Pair[] };
type Xf = { a: number; b: number; c: number; d: number; e: number; f: number };
const ID: Xf = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const apply = (m: Xf, x: number, y: number): [number, number] => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
const mul = (m: Xf, n: Xf): Xf => ({ a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d, e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f });

function pairsOf(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) {
      i -= 1; // resynchronise on a stray line
      continue;
    }
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

const g = (p: Pair[], code: number): string | undefined => p.find((x) => x[0] === code)?.[1];
const gn = (p: Pair[], code: number, d = 0): number => {
  const v = parseFloat(g(p, code) ?? "");
  return Number.isFinite(v) ? v : d;
};

/** Points of an arc (degrees, counter-clockwise from a0 to a1). */
function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): number[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 360;
  const n = Math.max(4, Math.min(64, Math.ceil(sweep / 8)));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = ((a0 + (sweep * i) / n) * Math.PI) / 180;
    out.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
  }
  return out;
}

/** A polyline with bulges (arc segments) as plain points. */
function bulged(verts: { x: number; y: number; bulge: number }[], closed: boolean): number[] {
  const out: number[] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    out.push(v.x, v.y);
    const w = verts[(i + 1) % n];
    if (!v.bulge || (i === n - 1 && !closed)) continue;
    // Arc from v to w with included angle 4·atan(bulge).
    const theta = 4 * Math.atan(v.bulge);
    const chord = Math.hypot(w.x - v.x, w.y - v.y);
    if (chord === 0) continue;
    // Signed sagitta and radius; the centre is on the chord's left by (r − s).
    const sag = (v.bulge * chord) / 2;
    const r = (chord * chord) / 4 / (2 * sag) + sag / 2;
    const mx = (v.x + w.x) / 2;
    const my = (v.y + w.y) / 2;
    const cx = mx - ((w.y - v.y) / chord) * (r - sag);
    const cy = my + ((w.x - v.x) / chord) * (r - sag);
    const a0 = Math.atan2(v.y - cy, v.x - cx);
    const steps = Math.max(2, Math.min(32, Math.ceil(Math.abs(theta) / 0.15)));
    for (let k = 1; k < steps; k++) {
      const a = a0 + (theta * k) / steps;
      out.push(cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a));
    }
  }
  if (closed && n > 1) out.push(verts[0].x, verts[0].y);
  return out;
}

function sections(pairs: Pair[]): Map<string, Pair[]> {
  const out = new Map<string, Pair[]>();
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === "SECTION" && pairs[i + 1]?.[0] === 2) {
      const name = pairs[i + 1][1];
      let j = i + 2;
      while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1] === "ENDSEC")) j++;
      out.set(name, pairs.slice(i + 2, j));
      i = j;
    }
  }
  return out;
}

function entitiesOf(pairs: Pair[]): Entity[] {
  const out: Entity[] = [];
  let cur: Entity | null = null;
  for (const p of pairs) {
    if (p[0] === 0) {
      cur = { type: p[1], pairs: [] };
      out.push(cur);
    } else cur?.pairs.push(p);
  }
  return out;
}

export function parseDxf(text: string): VectorPlan {
  if (text.startsWith("AutoCAD Binary DXF")) throw new Error("This is a binary DXF. Save it from AutoCAD as an ASCII DXF.");
  const pairs = pairsOf(text);
  const sec = sections(pairs);
  if (!sec.has("ENTITIES")) throw new Error("No ENTITIES section: is this a DXF file?");
  const header = sec.get("HEADER") ?? [];
  let insunits = 0;
  for (let i = 0; i < header.length; i++) if (header[i][0] === 9 && header[i][1] === "$INSUNITS") insunits = parseInt(header[i + 1]?.[1] ?? "0", 10) || 0;
  const [units, metresPerUnit] = UNITS[insunits] ?? UNITS[0];

  // Layer colours from the LAYER table.
  const layerColor = new Map<string, string>();
  for (const e of entitiesOf(sec.get("TABLES") ?? [])) {
    if (e.type !== "LAYER") continue;
    const name = g(e.pairs, 2);
    if (name) layerColor.set(name, ACI[Math.abs(gn(e.pairs, 62, 7))] ?? "#9ca3af");
  }

  // Blocks: name → entities (for INSERT).
  const blocks = new Map<string, { base: [number, number]; ents: Entity[] }>();
  {
    const ents = entitiesOf(sec.get("BLOCKS") ?? []);
    let cur: { name: string; base: [number, number]; ents: Entity[] } | null = null;
    for (const e of ents) {
      if (e.type === "BLOCK") cur = { name: g(e.pairs, 2) ?? "", base: [gn(e.pairs, 10), gn(e.pairs, 20)], ents: [] };
      else if (e.type === "ENDBLK") {
        if (cur) blocks.set(cur.name, { base: cur.base, ents: cur.ents });
        cur = null;
      } else cur?.ents.push(e);
    }
  }

  const layers = new Map<string, number[][]>();
  const skipped: Record<string, number> = {};
  let total = 0;
  const add = (layer: string, pts: number[], m: Xf) => {
    if (pts.length < 4) return;
    const out: number[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      const [x, y] = apply(m, pts[i], pts[i + 1]);
      out.push(Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000);
    }
    total += out.length / 2;
    if (total > MAX_PLAN_POINTS) throw new Error(`The plan has more than ${MAX_PLAN_POINTS.toLocaleString("en")} points. Delete hatches and detail layers (or explode fewer blocks) and export again.`);
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer)!.push(out);
  };

  const walk = (ents: Entity[], m: Xf, parentLayer: string | null, depth: number) => {
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const p = e.pairs;
      // Layer "0" inside a block takes the INSERT's layer.
      const own = g(p, 8) ?? "0";
      const layer = own === "0" && parentLayer ? parentLayer : own;
      switch (e.type) {
        case "LINE":
          add(layer, [gn(p, 10), gn(p, 20), gn(p, 11), gn(p, 21)], m);
          break;
        case "LWPOLYLINE": {
          const verts: { x: number; y: number; bulge: number }[] = [];
          for (const [code, v] of p) {
            if (code === 10) verts.push({ x: parseFloat(v), y: 0, bulge: 0 });
            else if (code === 20 && verts.length) verts[verts.length - 1].y = parseFloat(v);
            else if (code === 42 && verts.length) verts[verts.length - 1].bulge = parseFloat(v) || 0;
          }
          add(layer, bulged(verts, (gn(p, 70) & 1) === 1), m);
          break;
        }
        case "POLYLINE": {
          const closed = (gn(p, 70) & 1) === 1;
          const verts: { x: number; y: number; bulge: number }[] = [];
          let j = i + 1;
          for (; j < ents.length && ents[j].type === "VERTEX"; j++) verts.push({ x: gn(ents[j].pairs, 10), y: gn(ents[j].pairs, 20), bulge: gn(ents[j].pairs, 42) });
          if (ents[j]?.type === "SEQEND") i = j;
          else i = j - 1;
          add(layer, bulged(verts, closed), m);
          break;
        }
        case "CIRCLE":
          add(layer, arcPoints(gn(p, 10), gn(p, 20), gn(p, 40), 0, 360), m);
          break;
        case "ARC":
          add(layer, arcPoints(gn(p, 10), gn(p, 20), gn(p, 40), gn(p, 50), gn(p, 51)), m);
          break;
        case "ELLIPSE": {
          const cx = gn(p, 10);
          const cy = gn(p, 20);
          const mx = gn(p, 11);
          const my = gn(p, 21);
          const ratio = gn(p, 40, 1);
          const t0 = gn(p, 41, 0);
          let t1 = gn(p, 42, Math.PI * 2);
          if (t1 <= t0) t1 += Math.PI * 2;
          const pts: number[] = [];
          const n = 48;
          for (let k = 0; k <= n; k++) {
            const t = t0 + ((t1 - t0) * k) / n;
            const ux = Math.cos(t);
            const uy = Math.sin(t) * ratio;
            pts.push(cx + ux * mx - uy * my, cy + ux * my + uy * mx);
          }
          add(layer, pts, m);
          break;
        }
        case "SPLINE": {
          // Fit points when present, else the control polygon (close enough for tracing).
          const fit: number[] = [];
          const ctrl: number[] = [];
          let fx: number | null = null;
          let cx: number | null = null;
          for (const [code, v] of p) {
            if (code === 11) fx = parseFloat(v);
            else if (code === 21 && fx !== null) fit.push(fx, parseFloat(v));
            else if (code === 10) cx = parseFloat(v);
            else if (code === 20 && cx !== null) ctrl.push(cx, parseFloat(v));
          }
          add(layer, fit.length >= 4 ? fit : ctrl, m);
          break;
        }
        case "INSERT": {
          const blk = blocks.get(g(p, 2) ?? "");
          if (!blk || depth > 6) {
            skipped.INSERT = (skipped.INSERT ?? 0) + 1;
            break;
          }
          const sx = gn(p, 41, 1);
          const sy = gn(p, 42, 1);
          const rot = (gn(p, 50, 0) * Math.PI) / 180;
          const cols = Math.max(1, Math.min(50, gn(p, 70, 1)));
          const rows = Math.max(1, Math.min(50, gn(p, 71, 1)));
          const dc = gn(p, 44, 0);
          const dr = gn(p, 45, 0);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const ox = c * dc;
              const oy = r * dr;
              const cos = Math.cos(rot);
              const sin = Math.sin(rot);
              // insert · rotate · scale · (−base)
              const local: Xf = {
                a: cos * sx,
                b: sin * sx,
                c: -sin * sy,
                d: cos * sy,
                e: gn(p, 10) + cos * ox - sin * oy - (cos * sx * blk.base[0] - sin * sy * blk.base[1]),
                f: gn(p, 20) + sin * ox + cos * oy - (sin * sx * blk.base[0] + cos * sy * blk.base[1]),
              };
              walk(blk.ents, mul(m, local), layer, depth + 1);
            }
          }
          break;
        }
        case "VERTEX":
        case "SEQEND":
          break;
        default:
          skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      }
    }
  };
  walk(entitiesOf(sec.get("ENTITIES")!), ID, null, 0);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const lines of layers.values()) {
    for (const l of lines) {
      for (let i = 0; i < l.length; i += 2) {
        if (l[i] < minX) minX = l[i];
        if (l[i] > maxX) maxX = l[i];
        if (l[i + 1] < minY) minY = l[i + 1];
        if (l[i + 1] > maxY) maxY = l[i + 1];
      }
    }
  }
  if (!Number.isFinite(minX)) throw new Error("The DXF has no lines, polylines, circles or arcs to show.");
  return {
    units,
    metresPerUnit,
    bounds: { minX, minY, maxX, maxY },
    layers: [...layers.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, lines]) => ({ name: name.slice(0, 80), color: layerColor.get(name) ?? "#9ca3af", visible: true, lines })),
    skipped,
  };
}

/** Points in a plan's layers (for the size shown in the editor). */
export function planPoints(layers: Pick<VectorLayer, "lines">[]): number {
  return layers.reduce((s, l) => s + l.lines.reduce((t, x) => t + x.length / 2, 0), 0);
}
