/**
 * An SVG site plan as vector layers (browser-only): each top-level group is a
 * layer (its inkscape:label, id or "Layer n"); every path, line, polyline,
 * polygon, rect, circle and ellipse is sampled into a polyline in the file's
 * user units, y flipped so it points up. The markup is never shown: scripts,
 * images, foreign objects and event attributes are removed before the shapes
 * are measured off-screen.
 */
import type { VectorPlan } from "@/lib/venue/dxf";
import { MAX_PLAN_POINTS } from "@/lib/venue/dxf";

const SHAPES = "path, line, polyline, polygon, rect, circle, ellipse";

export function parseSvgPlan(text: string): VectorPlan {
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) throw new Error("That is not an SVG file.");
  root.querySelectorAll("script, foreignObject, image, iframe, use, style, a").forEach((n) => n.remove());
  root.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name) || /href$/i.test(a.name)) el.removeAttribute(a.name);
  });
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-10000px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden;pointer-events:none";
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  host.appendChild(svg);
  document.body.appendChild(host);
  try {
    const rootCtm = svg.getCTM() ?? svg.createSVGMatrix();
    const inv = rootCtm.inverse();
    const groups = Array.from(svg.children).filter((c) => c.nodeName.toLowerCase() === "g");
    const sources: { name: string; el: Element }[] = groups.length
      ? groups.map((g, i) => ({ name: g.getAttribute("inkscape:label") ?? g.getAttribute("id") ?? `Layer ${i + 1}`, el: g }))
      : [{ name: "Plan", el: svg }];
    let total = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const layers = sources.map(({ name, el }) => {
      const lines: number[][] = [];
      const shapes = Array.from(el.querySelectorAll(SHAPES)) as SVGGeometryElement[];
      if (el !== svg && (el as Element).matches(SHAPES)) shapes.unshift(el as SVGGeometryElement);
      for (const s of shapes) {
        let len = 0;
        try {
          len = s.getTotalLength();
        } catch {
          continue;
        }
        if (!Number.isFinite(len) || len <= 0) continue;
        const m = inv.multiply(s.getCTM() ?? svg.createSVGMatrix());
        const n = Math.max(2, Math.min(400, Math.ceil(len / 2)));
        const out: number[] = [];
        for (let i = 0; i <= n; i++) {
          const p = s.getPointAtLength((len * i) / n);
          const x = m.a * p.x + m.c * p.y + m.e;
          const y = -(m.b * p.x + m.d * p.y + m.f);
          out.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        total += out.length / 2;
        if (total > MAX_PLAN_POINTS) throw new Error("The SVG has too many points: simplify it (remove hatching and text) and export again.");
        lines.push(out);
      }
      return { name: name.slice(0, 80), color: "#8a94a6", visible: true, lines };
    });
    const kept = layers.filter((l) => l.lines.length);
    if (!kept.length) throw new Error("The SVG has no shapes to show.");
    return { units: "SVG units", metresPerUnit: 1, bounds: { minX, minY, maxX, maxY }, layers: kept, skipped: {} };
  } finally {
    host.remove();
  }
}
