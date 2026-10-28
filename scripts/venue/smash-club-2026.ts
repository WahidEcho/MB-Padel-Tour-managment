/**
 * Builds the Smash Sporting Club venue document from the CAD site plan
 * ("Tennis layout.pdf" rendered at 200 dpi, 3309 × 2339 px) and the owner's
 * hand-numbered satellite print. Plan pixels → metres: s m/px, y flipped.
 */
import { writeFileSync } from "node:fs";

/**
 * Output folder: doc.json (paste into Admin → Venue map → Import JSON), underlay.json and check.html
 * (expects a 200 dpi render of the plan named site-plan.png next to it).
 *   npx tsx scripts/venue/smash-club-2026.ts <out dir>
 */
const OUT = process.argv[2] ?? ".";
import { parseVenue, venueWarnings } from "@/lib/venue/validate";
import { localToGeo, geoToLocal } from "@/lib/venue/geo";
import { DEFAULT_CATEGORIES } from "@/lib/venue/categories";
import type { VenueDoc, VenueCourt, VenueBuilding, WalkNode, WalkEdge, VenuePoi, Pt } from "@/lib/venue/types";

const W = 3309, H = 2339;
const s = 0.149; // metres per plan pixel (court lines: 72 px ≈ 10.97 m, 160 px ≈ 23.77 m)
const P = (px: number, py: number): Pt => ({ x: +(px * s).toFixed(2), y: +((H - py) * s).toFixed(2) });
const rectPx = (x0: number, y0: number, x1: number, y1: number): Pt[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const octPx = (cx: number, cy: number, r: number): Pt[] => [...Array(8)].map((_, i) => P(cx + r * Math.cos((i * Math.PI) / 4), cy + r * Math.sin((i * Math.PI) / 4)));

// Court centres in plan pixels (numbers from the owner's satellite print).
const COURTS: Record<number, [number, number]> = {
  3: [2485, 906], 2: [2600, 906], 1: [2710, 906],
  4: [2485, 1270], 5: [2600, 1270], 6: [2710, 1270],
  14: [1965, 1575], 13: [2192, 1575],
  11: [2425, 1545], 10: [2548, 1545], 9: [2691, 1545], 8: [2812, 1545], 7: [2979, 1545],
  16: [2142, 1905], 15: [2265, 1905], 12: [2428, 1905],
};
const BJK = new Set([1, 2, 3, 4, 5, 6, 14, 16]);
const TV = new Set([13, 14]);

const courts: VenueCourt[] = Object.entries(COURTS)
  .map(([n, [px, py]]) => {
    const num = Number(n);
    return {
      id: `c${num}`, number: num, name: `Court ${num}`, event: BJK.has(num) ? "bjk" : "dc",
      center: P(px, py), width: TV.has(num) ? 21 : 17, length: TV.has(num) ? 40 : 36, angleDeg: 0,
      surface: "clay" as const, ...(TV.has(num) ? { streamed: true } : {}),
    };
  })
  .sort((a, b) => a.number - b.number);

const buildings: VenueBuilding[] = [
  { id: "stand-14", name: "Court 14 stand", kind: "stand", polygon: rectPx(2048, 1440, 2110, 1710), height: 4 },
  { id: "stand-13", name: "Court 13 stand", kind: "stand", polygon: rectPx(2278, 1440, 2340, 1710), height: 4 },
  { id: "pitch", name: "Football pitch", kind: "area", polygon: [P(1400, 1117), P(1770, 1117), P(1817, 1170), P(1817, 1900), P(1770, 1950), P(1400, 1950), P(1350, 1900), P(1350, 1170)], height: 0.1 },
  { id: "other-courts", name: "Courts not in use", kind: "area", polygon: rectPx(1820, 1785, 2050, 2030), height: 0.1 },
  { id: "clubhouse", name: "Clubhouse", kind: "building", polygon: rectPx(1885, 300, 2300, 767), height: 8 },
  { id: "pool-deck", name: "Pool", kind: "area", polygon: rectPx(1885, 780, 2280, 990), height: 0.1 },
  { id: "carpark", name: "Car park", kind: "area", polygon: rectPx(1067, 200, 1830, 500), height: 0.1 },
  { id: "courts-wall", name: "Hedge", kind: "wall", polygon: rectPx(1812, 1210, 1850, 2040), height: 2.5 },
  { id: "existing-n", name: "Existing club building", kind: "building", polygon: [P(2960, 420), P(3200, 420), P(3200, 700), P(2960, 700)], height: 6 },
  { id: "lockers-n", name: "Players' lockers (north)", kind: "building", polygon: octPx(2916, 922, 112), height: 5 },
  { id: "round-plaza", name: "Round plaza", kind: "area", polygon: rectPx(2815, 1163, 3017, 1391), height: 0.1 },
  { id: "existing-s", name: "Referee room & players' lounge", kind: "building", polygon: rectPx(2720, 1790, 3300, 2060), height: 5 },
  { id: "lockers-s", name: "Players' lockers (south)", kind: "building", polygon: rectPx(1380, 1960, 1800, 2045), height: 4 },
];

const N = (id: string, px: number, py: number, label?: string): WalkNode => ({ id, ...P(px, py), ...(label ? { label } : {}) });
const nodes: WalkNode[] = [
  N("eg", 3060, 1092, "Gate 1"), N("booth", 3010, 1140),
  N("vip", 1954, 240, "the VIP gate"), N("vr1", 1855, 300), N("lk", 1700, 2058, "the players' lockers"), N("v3", 1880, 2058),
  N("t3000", 3000, 1050), N("t2700", 2700, 1050), N("sp2", 2355, 1050, "the path between the club and the courts"),
  N("sp1", 2355, 760), N("sp3", 2355, 1420), N("sp4", 2355, 1770), N("sp5", 2355, 2040),
  N("m2700", 2700, 1420), N("m2920", 2920, 1420), N("m3050", 3075, 1420),
  N("b2700", 2700, 1715), N("b3000", 3075, 1715),
  N("g1770", 2160, 1770), N("cg", 1945, 1740, "the courts gate"), N("v2", 1880, 1770),
  N("v1", 1880, 1420), N("w3", 1880, 1085), N("w4", 2150, 1085, "the players' buffet"), N("w2", 1500, 1085), N("wg", 1150, 1092, "the Fans Gate"),
  N("pk", 1150, 520), N("park", 1450, 520, "the car park"),
];
const chain = (...ids: string[]): WalkEdge[] => ids.slice(1).map((b, i) => ({ a: ids[i], b }));
const edges: WalkEdge[] = [
  ...chain("eg", "t3000", "t2700", "sp2", "sp1"),
  ...chain("eg", "booth", "m3050", "m2920", "m2700", "sp3"),
  ...chain("sp2", "sp3", "sp4", "sp5"),
  ...chain("m3050", "b3000", "b2700", "sp4"),
  ...chain("sp4", "g1770", "cg", "v2", "v1", "w3", "w4", "sp2"),
  ...chain("w3", "w2", "wg", "pk", "park"),
  ...chain("vip", "vr1", "w3"),
  ...chain("v2", "v3", "lk"),
];

const pois: VenuePoi[] = [
  { id: "fans-gate", category: "entrance", name: "Fans Gate (6)", point: P(1150, 1100), main: true },
  { id: "gate-1", category: "entrance", name: "Players & Referees (Gate 1)", point: P(3068, 1092) },
  { id: "vip-gate", category: "entrance", name: "VIP Gate (5)", point: P(1954, 228) },
  { id: "courts-gate", category: "entrance", name: "Courts gate", point: P(1945, 1735) },
  { id: "booth", category: "desk", name: "Information booth", point: P(3010, 1180) },
  { id: "parking", category: "parking", name: "Car park", point: P(1450, 350) },
  { id: "buffet", category: "food", name: "Players' buffet", point: P(1960, 1215) },
  { id: "toilets", category: "toilets", name: "Public toilets", point: P(2300, 1428) },
  { id: "referee", category: "referee", name: "Referee room", point: P(3010, 1830), indoor: true },
  { id: "lounge", category: "lounge", name: "Players' lounge", point: P(2790, 1900), indoor: true },
  { id: "poi-lockers-n", category: "lounge", name: "Players' lockers (north)", point: P(2916, 922), indoor: true },
  { id: "poi-lockers-s", category: "lounge", name: "Players' lockers (south)", point: P(1700, 2000), indoor: true },
];

// Geo: Google Maps centres of Court 1 (30.119130, 31.401670) and Court 16 (30.117861, 31.400788).
const refs = [
  { plan: P(...COURTS[1]), lat: 30.11913, lng: 31.40167 },
  { plan: P(...COURTS[16]), lat: 30.117861, lng: 31.400788 },
];
// Origin from each reference, then the mean.
const origins = refs.map((r) => {
  const mLat = 111_132.954 - 559.822 * Math.cos(2 * r.lat * Math.PI / 180);
  const mLng = (Math.PI / 180) * 6_371_008.8 * Math.cos(r.lat * Math.PI / 180);
  return { lat: r.lat - r.plan.y / mLat, lng: r.lng - r.plan.x / mLng };
});
const geo = { lat: +(origins.reduce((a, o) => a + o.lat, 0) / 2).toFixed(7), lng: +(origins.reduce((a, o) => a + o.lng, 0) / 2).toFixed(7), rotationDeg: 0, scale: 1 };

const doc: VenueDoc = {
  schema: 1,
  name: "Smash Sporting Club",
  note: "Drawn from the club's site plan (Oct 2026). Courts from the numbered satellite print; gates from the plan's gate marks. Gates, lockers, referee room, lounge and buffet from the organiser's marked satellite view. Medical and prayer room still to be placed.",
  geo,
  boundary: rectPx(1033, 217, 3309, 2067),
  events: [
    { key: "dc", label: "Davis Cup Junior Finals", color: "#1f6fd1", slugs: ["davis-cup-junior-finals-2026"] },
    { key: "bjk", label: "Billie Jean King Cup Junior Finals", color: "#e0457b", slugs: ["bjk-cup-junior-finals-2026"] },
  ],
  categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
  courts, buildings, walkways: { nodes, edges }, pois,
};

const parsed = parseVenue(doc);
console.log("problems:", (parsed as any).problems ?? (parsed as any).problem ?? "none");
const courtRows = [...Array(16)].map((_, i) => ({ slug: BJK.has(i + 1) ? "bjk-cup-junior-finals-2026" : "davis-cup-junior-finals-2026", court_name: `Court ${i + 1}` }));
console.log("warnings:", venueWarnings(doc, courtRows));
for (const r of refs) {
  const back = geoToLocal(geo, r.lat, r.lng);
  console.log("ref residual m:", (back.x - r.plan.x).toFixed(1), (back.y - r.plan.y).toFixed(1));
}
console.log("court 13 at", localToGeo(geo, courts.find((c) => c.number === 13)!.center));

const underlay = { kind: "image", url: "https://tour.mbeg.org/venue/smash-2026/site-plan.jpg", width: W, height: H, center: P(W / 2, H / 2), rotationDeg: 0, scale: s, opacity: 0.6 };
writeFileSync(`${OUT}/doc.json`, JSON.stringify(doc));
writeFileSync(`${OUT}/underlay.json`, JSON.stringify(underlay));

// Check overlay on the plan (plan px).
const toPx = (p: Pt) => [p.x / s, H - p.y / s];
const svg: string[] = [];
for (const b of buildings) svg.push(`<polygon points="${b.polygon.map((p) => toPx(p).join(",")).join(" ")}" fill="${b.kind === "area" ? "#9ca3af" : b.kind === "stand" ? "#f59e0b" : "#374151"}" fill-opacity="0.35" stroke="#111" stroke-width="3"/><text x="${toPx(b.polygon[0])[0] + 8}" y="${toPx(b.polygon[0])[1] + 34}" font-size="28" font-family="Helvetica">${b.name}</text>`);
for (const c of courts) { const [x, y] = toPx(c.center); const w = c.width / s, h = c.length / s; const col = c.event === "bjk" ? "#e0457b" : "#1f6fd1"; svg.push(`<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" fill="${col}" fill-opacity="0.3" stroke="${col}" stroke-width="4"/><text x="${x}" y="${y + 20}" font-size="56" font-weight="bold" text-anchor="middle" fill="${col}" font-family="Helvetica">${c.number}</text>`); }
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
for (const e of edges) { const a = toPx(byId[e.a]), b = toPx(byId[e.b]); svg.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#16a34a" stroke-width="8" stroke-opacity="0.8"/>`); }
for (const n of nodes) { const [x, y] = toPx(n); svg.push(`<circle cx="${x}" cy="${y}" r="10" fill="#16a34a"/>`); }
for (const p of pois) { const [x, y] = toPx(p.point); svg.push(`<circle cx="${x}" cy="${y}" r="22" fill="#dc2626" stroke="#fff" stroke-width="4"/><text x="${x + 28}" y="${y + 10}" font-size="30" font-family="Helvetica" fill="#dc2626" font-weight="bold">${p.name}</text>`); }
const bd = doc.boundary!.map((p) => toPx(p).join(",")).join(" ");
svg.push(`<polygon points="${bd}" fill="none" stroke="#0a0" stroke-width="5" stroke-dasharray="20 12"/>`);
writeFileSync(`${OUT}/check.html`, `<html><body style="margin:0"><div style="position:relative;width:${W}px;height:${H}px"><img src="site-plan.png" style="position:absolute;left:0;top:0"><svg style="position:absolute;left:0;top:0" width="${W}" height="${H}">${svg.join("")}</svg></div></body></html>`);
