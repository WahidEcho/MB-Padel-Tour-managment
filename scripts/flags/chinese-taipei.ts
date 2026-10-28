/**
 * Draws public/flags/tw.svg as the Chinese Taipei Olympic flag (the flag Chinese Taipei plays under at ITF events),
 * in the flag set's 640×480 frame: white field; a five-petal plum blossom drawn as a thick blue line, a white gap and
 * a red line; the Blue Sky with a White Sun (twelve rays) above the Olympic rings.
 * Proportions measured from the 3:2 reference and scaled by height. Then run `sh scripts/flags/render-png.sh`.
 *
 *   npx tsx scripts/flags/chinese-taipei.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const H = 480;
const CX = 320;
const CY = 240;
const BLUE = "#003893";
const RED = "#e22026";
const f = (n: number) => +n.toFixed(2);

/* ---------------- plum blossom: the red line's centre, then bands either side ---------------- */

// The outline is the edge of five overlapping circles, one per petal (petal 0 points straight up): round petals
// meeting in a sharp V.
const PETAL_D = 0.17 * H;
const PETAL_R = 0.15 * H;
const petals = [...Array(5)].map((_, k) => -Math.PI / 2 + (k * 2 * Math.PI) / 5);
const circles = petals.map((a) => ({ x: PETAL_D * Math.cos(a), y: PETAL_D * Math.sin(a), r: PETAL_R }));
// The shape is star-shaped from the centre: along each ray, the outline is the farthest exit from any circle.
const outline: [number, number][] = [];
const STEPS = 1440;
for (let i = 0; i < STEPS; i++) {
  const t = -Math.PI / 2 + (i * 2 * Math.PI) / STEPS;
  const ux = Math.cos(t);
  const uy = Math.sin(t);
  let far = 0;
  for (const c of circles) {
    const b = c.x * ux + c.y * uy;
    const disc = b * b - (c.x * c.x + c.y * c.y - c.r * c.r);
    if (disc >= 0) far = Math.max(far, b + Math.sqrt(disc));
  }
  outline.push([CX + far * ux, CY + far * uy]);
}
const blossomPath = `M${outline.map(([x, y]) => `${f(x)},${f(y)}`).join("L")}Z`;
const RED_W = 0.023 * H;
const GAP_W = 0.019 * H;
const BLUE_W = 0.042 * H;
const blossom = [
  `<path d="${blossomPath}" fill="none" stroke="${BLUE}" stroke-width="${f(RED_W + 2 * (GAP_W + BLUE_W))}" stroke-linejoin="round"/>`,
  `<path d="${blossomPath}" fill="none" stroke="#fff" stroke-width="${f(RED_W + 2 * GAP_W)}" stroke-linejoin="round"/>`,
  // White inside covers the inner halves of the wider bands, so only the red line sits on the inside.
  `<path d="${blossomPath}" fill="#fff"/>`,
  `<path d="${blossomPath}" fill="none" stroke="${RED}" stroke-width="${f(RED_W)}" stroke-linejoin="miter" stroke-miterlimit="8"/>`,
].join("");

/* ---------------- Blue Sky with a White Sun ---------------- */

const SX = CX;
const SY = 0.41 * H;
const SUN_R = 0.098 * H;
const rays: string[] = [];
for (let k = 0; k < 12; k++) {
  const a = -Math.PI / 2 + (k * Math.PI) / 6;
  const tip = 0.092 * H;
  const base = 0.056 * H;
  const half = Math.PI / 12;
  const pts = [
    [SX + tip * Math.cos(a), SY + tip * Math.sin(a)],
    [SX + base * Math.cos(a - half), SY + base * Math.sin(a - half)],
    [SX + base * Math.cos(a + half), SY + base * Math.sin(a + half)],
  ];
  rays.push(`<polygon points="${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}" fill="#fff"/>`);
}
const sun = [
  `<circle cx="${SX}" cy="${f(SY)}" r="${f(SUN_R)}" fill="${BLUE}"/>`,
  ...rays,
  `<circle cx="${SX}" cy="${f(SY)}" r="${f(0.056 * H)}" fill="#fff"/>`,
  `<circle cx="${SX}" cy="${f(SY)}" r="${f(0.0505 * H)}" fill="${BLUE}"/>`,
  `<circle cx="${SX}" cy="${f(SY)}" r="${f(0.046 * H)}" fill="#fff"/>`,
].join("");

/* ---------------- Olympic rings, interlaced ---------------- */

const RING_R = 0.0574 * H;
const RING_W = 0.0102 * H;
const GAP = 0.136 * H;
const TOP_Y = 0.611 * H;
const LOW_Y = 0.669 * H;
const ring = {
  blue: { x: CX - GAP, y: TOP_Y, c: "#0081c8" },
  black: { x: CX, y: TOP_Y, c: "#000000" },
  red: { x: CX + GAP, y: TOP_Y, c: "#ee334e" },
  yellow: { x: CX - GAP / 2, y: LOW_Y, c: "#fcb131" },
  green: { x: CX + GAP / 2, y: LOW_Y, c: "#00a651" },
};
type RingKey = keyof typeof ring;
const circle = (k: RingKey, extra = "") => `<circle cx="${f(ring[k].x)}" cy="${f(ring[k].y)}" r="${f(RING_R)}" fill="none" stroke="${ring[k].c}" stroke-width="${f(RING_W)}"${extra}/>`;
// Where two rings cross: the upper (smaller y) or lower point.
function crossing(a: RingKey, b: RingKey, which: "upper" | "lower") {
  const p = ring[a];
  const q = ring[b];
  const d = Math.hypot(q.x - p.x, q.y - p.y);
  const h = Math.sqrt(RING_R * RING_R - (d / 2) ** 2);
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const ux = (q.x - p.x) / d;
  const uy = (q.y - p.y) / d;
  const pts = [
    { x: mx - uy * h, y: my + ux * h },
    { x: mx + uy * h, y: my - ux * h },
  ].sort((m, n) => m.y - n.y);
  return which === "upper" ? pts[0] : pts[1];
}
// Lower rings are drawn over the upper ones; these crossings put the other ring back on top (as on the reference:
// at the upper crossings the left ring is on top, at the lower ones the right ring).
const over: [RingKey, RingKey, "upper" | "lower"][] = [
  ["blue", "yellow", "upper"],
  ["black", "yellow", "lower"],
  ["black", "green", "upper"],
  ["red", "green", "lower"],
];
const clips = over.map(([top, under, which], i) => {
  const p = crossing(top, under, which);
  return `<clipPath id="x${i}"><circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(RING_W * 1.6)}"/></clipPath>`;
});
const rings = [
  circle("blue"),
  circle("black"),
  circle("red"),
  circle("yellow"),
  circle("green"),
  ...over.map(([top], i) => circle(top, ` clip-path="url(#x${i})"`)),
].join("");

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" id="flag-icons-tw" viewBox="0 0 640 480">` +
  `<!-- Chinese Taipei Olympic flag, drawn by scripts/flags/chinese-taipei.ts -->` +
  `<defs>${clips.join("")}</defs>` +
  `<rect width="640" height="480" fill="#fff"/>${blossom}${sun}${rings}</svg>`;

const out = join(__dirname, "../../public/flags/tw.svg");
writeFileSync(out, svg);
console.log(`wrote ${out} (${svg.length} bytes)`);
