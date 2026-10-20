/**
 * The editor's site plan under the drawing (venue_maps.underlay): an uploaded
 * aerial image, or the vector layers of an imported DXF / SVG plan, with its
 * placement on the venue plan (centre, rotation, scale, opacity). Read
 * strictly, like the venue document. Pure.
 */
import { MAX_PLAN_POINTS } from "./dxf";
import type { UnderlayPlacement, VectorLayer, VenueUnderlay } from "./types";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : d);

function placement(v: Record<string, unknown>): UnderlayPlacement {
  const c = isObj(v.center) ? v.center : {};
  return {
    center: { x: num(c.x, -1e5, 1e5, 0), y: num(c.y, -1e5, 1e5, 0) },
    rotationDeg: num(v.rotationDeg, -3600, 3600, 0),
    scale: num(v.scale, 1e-7, 1e4, 1),
    opacity: num(v.opacity, 0.05, 1, 0.6),
  };
}

export function parseUnderlay(input: unknown): { underlay: VenueUnderlay | null; problem: string | null } {
  if (input === null) return { underlay: null, problem: null };
  if (!isObj(input)) return { underlay: null, problem: "That is not a site plan." };
  if (input.kind === "image") {
    const url = typeof input.url === "string" && input.url.length <= 500 && /^https?:\/\//.test(input.url) ? input.url : null;
    if (!url) return { underlay: null, problem: "The image needs an http(s) address." };
    return {
      underlay: { kind: "image", url, width: Math.round(num(input.width, 1, 20000, 1000)), height: Math.round(num(input.height, 1, 20000, 1000)), ...placement(input) },
      problem: null,
    };
  }
  if (input.kind === "vector") {
    const raw = Array.isArray(input.layers) ? input.layers.slice(0, 400) : [];
    const layers: VectorLayer[] = [];
    let total = 0;
    for (const l of raw) {
      if (!isObj(l) || !Array.isArray(l.lines)) continue;
      const lines: number[][] = [];
      for (const line of l.lines) {
        if (!Array.isArray(line) || line.length < 4 || line.length % 2 !== 0) continue;
        if (!line.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 1e9)) continue;
        total += line.length / 2;
        if (total > MAX_PLAN_POINTS) return { underlay: null, problem: `The plan has more than ${MAX_PLAN_POINTS.toLocaleString("en")} points: hide detail layers and save again.` };
        lines.push(line as number[]);
      }
      layers.push({
        name: typeof l.name === "string" ? l.name.slice(0, 80) : "Layer",
        color: typeof l.color === "string" && /^#[0-9a-fA-F]{6}$/.test(l.color) ? l.color : "#9ca3af",
        visible: l.visible !== false,
        lines,
      });
    }
    if (!layers.length) return { underlay: null, problem: "The plan has no layers with lines." };
    const b = isObj(input.bounds) ? input.bounds : {};
    return {
      underlay: {
        kind: "vector",
        source: input.source === "svg" ? "svg" : "dxf",
        fileName: typeof input.fileName === "string" ? input.fileName.slice(0, 120) : "plan",
        units: typeof input.units === "string" ? input.units.slice(0, 30) : "unitless",
        bounds: { minX: num(b.minX, -1e9, 1e9, 0), minY: num(b.minY, -1e9, 1e9, 0), maxX: num(b.maxX, -1e9, 1e9, 1), maxY: num(b.maxY, -1e9, 1e9, 1) },
        layers,
        ...placement(input),
      },
      problem: null,
    };
  }
  return { underlay: null, problem: "Unknown kind of site plan." };
}
