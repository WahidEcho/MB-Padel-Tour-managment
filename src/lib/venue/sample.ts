/**
 * A realistic sample venue so the map, the routes and the editor can be tried
 * before the real club plan arrives: 16 numbered courts in two rows (Davis Cup
 * Juniors on 1–8, Billie Jean King Cup Juniors on 9–16, Courts 1 and 9 streamed
 * with stands), the clubhouse with its café and buffet, toilets, medical,
 * referee office, tournament desk, players' lounge, prayer room, the main
 * entrance, a second gate, the car park and the walkways between them.
 *
 * SAMPLE LAYOUT — replace with the real club plan (Smash Sporting Club,
 * 104 Airport Rd, Sheraton Al Matar, El Nozha, Cairo). The anchor is a
 * placeholder near the club; the owner sends the exact coordinates and pin
 * points. Plan metres, origin at the anchor, +y = north (rotation 0).
 */
import { DEFAULT_CATEGORIES } from "./categories";
import type { Pt, VenueCourt, VenueDoc, WalkEdge, WalkNode } from "./types";

/** Placeholder anchor (approximate, near Sheraton Al Matar / Airport Rd, Cairo). Replace with the surveyed reference point. */
export const SAMPLE_ANCHOR = { lat: 30.1008, lng: 31.3708 };

export const SAMPLE_NOTE = "Sample layout — replace with the real club plan.";

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

function courts(): VenueCourt[] {
  const out: VenueCourt[] = [];
  // Four pairs of courts per row; a 6 m gap between pairs carries a cross path.
  const xs = [0, 1, 2, 3].flatMap((k) => [104 + k * 42, 122 + k * 42]);
  xs.forEach((x, i) => {
    out.push({ id: `c${i + 1}`, number: i + 1, name: `Court ${i + 1}`, event: "dc", center: { x, y: 40 }, width: 18, length: 36, angleDeg: 0, surface: "hard", ...(i === 0 ? { streamed: true } : {}) });
  });
  xs.forEach((x, i) => {
    out.push({ id: `c${i + 9}`, number: i + 9, name: `Court ${i + 9}`, event: "bjk", center: { x, y: 110 }, width: 18, length: 36, angleDeg: 0, surface: "hard", ...(i === 0 ? { streamed: true } : {}) });
  });
  return out;
}

const N = (id: string, x: number, y: number, label?: string): WalkNode => ({ id, x, y, ...(label ? { label } : {}) });

function walkways(): { nodes: WalkNode[]; edges: WalkEdge[] } {
  const nodes: WalkNode[] = [
    N("gate", 40, -30, "the Main Entrance"),
    N("park", 40, -46),
    N("plaza", 40, -12, "the entrance plaza"),
    N("j1", 40, 12),
    N("gateb", 150, -30, "Gate B"),
    N("s80", 80, 12),
    N("s134", 134, 12),
    N("s150", 150, 12),
    N("s176", 176, 12),
    N("s218", 218, 12),
    N("s262", 262, 12),
    N("sp48", 80, 48),
    N("c1", 64, 48, "the clubhouse terrace"),
    N("p80", 80, 75, "the promenade"),
    N("p134", 134, 75),
    N("p176", 176, 75),
    N("p218", 218, 75),
    N("p262", 262, 75),
    N("w66", 66, 75),
    N("w30", 30, 75),
    N("n80", 80, 142),
    N("n134", 134, 142),
    N("n176", 176, 142),
    N("n218", 218, 142),
    N("n262", 262, 142),
    N("n43", 43, 142),
    N("n15", 15, 142),
  ];
  const chain = (...ids: string[]): WalkEdge[] => ids.slice(1).map((b, i) => ({ a: ids[i], b }));
  const edges: WalkEdge[] = [
    ...chain("park", "gate", "plaza", "j1", "s80", "s134", "s150", "s176", "s218", "s262"),
    ...chain("gateb", "s150"),
    ...chain("s80", "sp48", "p80", "n80"),
    ...chain("c1", "sp48"),
    ...chain("w30", "w66", "p80", "p134", "p176", "p218", "p262"),
    ...chain("n15", "n43", "n80", "n134", "n176", "n218", "n262"),
    ...chain("s134", "p134", "n134"),
    ...chain("s176", "p176", "n176"),
    ...chain("s218", "p218", "n218"),
    ...chain("s262", "p262", "n262"),
  ];
  return { nodes, edges };
}

export function sampleVenue(): VenueDoc {
  return {
    schema: 1,
    name: "Smash Sporting Club (sample layout)",
    sample: true,
    note: SAMPLE_NOTE,
    geo: { lat: SAMPLE_ANCHOR.lat, lng: SAMPLE_ANCHOR.lng, rotationDeg: 0, scale: 1 },
    boundary: [
      { x: -5, y: -62 },
      { x: 100, y: -62 },
      { x: 100, y: -34 },
      { x: 290, y: -34 },
      { x: 290, y: 165 },
      { x: -5, y: 165 },
    ],
    events: [
      { key: "dc", label: "Davis Cup Juniors", color: "#1f6fd1" },
      { key: "bjk", label: "Billie Jean King Cup Juniors", color: "#8a3ffc" },
    ],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    courts: courts(),
    buildings: [
      { id: "clubhouse", name: "Clubhouse", kind: "building", polygon: rect(10, 30, 60, 65), height: 9 },
      { id: "desk-kiosk", name: "Tournament desk", kind: "building", polygon: rect(46, -10, 58, 0), height: 3.2 },
      { id: "toilets-w", name: "Toilets", kind: "building", polygon: rect(20, 85, 40, 100), height: 3.5 },
      { id: "medical-b", name: "Medical", kind: "building", polygon: rect(46, 85, 60, 100), height: 3.5 },
      { id: "referee-b", name: "Referee office", kind: "building", polygon: rect(20, 120, 40, 135), height: 4 },
      { id: "lounge-b", name: "Players' lounge", kind: "building", polygon: rect(46, 120, 66, 135), height: 4.5 },
      { id: "prayer-b", name: "Prayer room", kind: "building", polygon: rect(20, 148, 34, 158), height: 3.5 },
      { id: "toilets-e", name: "Toilets (east)", kind: "building", polygon: rect(266, 68, 276, 82), height: 3.2 },
      { id: "stand-1", name: "Court 1 stand", kind: "stand", polygon: rect(84, 26, 92, 54), height: 3.5 },
      { id: "stand-9", name: "Court 9 stand", kind: "stand", polygon: rect(84, 96, 92, 124), height: 3.5 },
      { id: "carpark", name: "Car park", kind: "area", polygon: rect(0, -60, 90, -36), height: 0.2 },
    ],
    walkways: walkways(),
    pois: [
      { id: "main-gate", category: "entrance", name: "Main Entrance", point: { x: 40, y: -30 }, main: true },
      { id: "gate-b", category: "entrance", name: "Gate B (players & officials)", point: { x: 150, y: -30 } },
      { id: "parking", category: "parking", name: "Car park", point: { x: 40, y: -46 } },
      { id: "desk", category: "desk", name: "Tournament desk", point: { x: 44, y: -5 } },
      { id: "cafe", category: "food", name: "Clubhouse café & buffet", point: { x: 64, y: 48 } },
      { id: "wc-west", category: "toilets", name: "Toilets", point: { x: 30, y: 81 } },
      { id: "wc-east", category: "toilets", name: "Toilets (east)", point: { x: 264, y: 75 } },
      { id: "medical", category: "medical", name: "Medical", point: { x: 53, y: 81 } },
      { id: "referee", category: "referee", name: "Referee office", point: { x: 30, y: 138 } },
      { id: "lounge", category: "lounge", name: "Players' lounge", point: { x: 56, y: 138 } },
      { id: "prayer", category: "prayer", name: "Prayer room", point: { x: 27, y: 145 } },
    ],
  };
}

/** A blank venue at the sample anchor (the editor's starting point without the sample). */
export function emptyVenue(name = "Venue"): VenueDoc {
  return {
    schema: 1,
    name,
    geo: { lat: SAMPLE_ANCHOR.lat, lng: SAMPLE_ANCHOR.lng, rotationDeg: 0, scale: 1 },
    events: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    courts: [],
    buildings: [],
    walkways: { nodes: [], edges: [] },
    pois: [],
  };
}
