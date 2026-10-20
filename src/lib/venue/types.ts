/**
 * The venue document (venue_maps.doc, schema 1): everything the 3D map, the
 * router and the editor know about a venue. Pure types, shared with the app
 * through @core.
 *
 * Coordinates are plan metres: x to the right of the site plan, y up the plan
 * (a right-handed frame, so a positive turn is to the left). `geo` ties the
 * plan to the world: the plan's origin sits at (lat, lng), the plan's +y axis
 * points `rotationDeg` clockwise from true north, and one plan unit is `scale`
 * metres (1 for a plan drawn in metres).
 */

export const VENUE_SCHEMA = 1;

export interface Pt {
  x: number;
  y: number;
}

export interface VenueGeo {
  lat: number;
  lng: number;
  rotationDeg: number;
  scale: number;
}

/** A GPS position taken in Survey mode: the mean of `samples` fixes. */
export interface SurveyFix {
  lat: number;
  lng: number;
  /** Metres (68 % radius), of the averaged position. */
  accuracy: number;
  samples: number;
  at: string;
  /** "move": the feature was placed here. "align": a reference spot that lines the plan up (src/lib/venue/fit.ts). */
  mode: "move" | "align";
}

/** One of the events played at the venue, with its court colour. */
export interface VenueEvent {
  key: string;
  label: string;
  color: string;
  /** Tournament slugs of the event (optional; courts link by name across every tournament of the venue). */
  slugs?: string[];
}

export interface VenueCourt {
  id: string;
  number: number;
  /** Matches `courts.court_name` of the venue's tournaments ("Court 7"), case and spacing aside. */
  name: string;
  /** VenueEvent.key, or null for a court both events share. */
  event: string | null;
  center: Pt;
  /** The fenced area, metres (a tennis court with run-off is about 18 × 36). */
  width: number;
  length: number;
  /** Rotation of the court's long axis from the plan's +y axis, degrees counter-clockwise. */
  angleDeg: number;
  streamed?: boolean;
  surface?: "hard" | "clay" | "grass" | "padel";
  survey?: SurveyFix;
}

/** "area" is a paved surface (a car park): drawn flat, never in the way. "canopy" is a roof people walk under. */
export type BuildingKind = "building" | "stand" | "canopy" | "wall" | "area";

export interface VenueBuilding {
  id: string;
  name: string;
  kind: BuildingKind;
  polygon: Pt[];
  /** Metres. */
  height: number;
}

export interface WalkNode extends Pt {
  id: string;
  /** A name used in directions ("the clubhouse terrace"). */
  label?: string;
  survey?: SurveyFix;
}

export interface WalkEdge {
  a: string;
  b: string;
  /** "indoor" may pass through a building. */
  kind?: "path" | "indoor" | "stairs";
}

export interface PoiCategory {
  key: string;
  label: string;
  /** An icon key the map draws (src/components/venue/icons.ts). */
  icon: string;
  color: string;
}

export interface VenuePoi {
  id: string;
  category: string;
  name: string;
  point: Pt;
  floor?: number;
  indoor?: boolean;
  /** The main entrance: routes start here when the phone's location is unusable. */
  main?: boolean;
  survey?: SurveyFix;
}

export interface VenueDoc {
  schema: 1;
  name: string;
  /** A made-up layout for testing: the map says so. */
  sample?: boolean;
  note?: string;
  geo: VenueGeo;
  /** The site boundary (grass is drawn inside it). */
  boundary?: Pt[];
  events: VenueEvent[];
  categories: PoiCategory[];
  courts: VenueCourt[];
  buildings: VenueBuilding[];
  walkways: { nodes: WalkNode[]; edges: WalkEdge[] };
  pois: VenuePoi[];
}

/* ---------------- the editor's underlay (venue_maps.underlay, never public) ---------------- */

export interface UnderlayPlacement {
  /** Where the underlay's centre sits on the plan. */
  center: Pt;
  /** Degrees counter-clockwise. */
  rotationDeg: number;
  /** Metres per underlay unit (image: metres per pixel; DXF/SVG: metres per drawing unit). */
  scale: number;
  opacity: number;
}

export interface VectorLayer {
  name: string;
  color: string;
  visible: boolean;
  /** Polylines in drawing units, flattened [x0, y0, x1, y1, …], y up. */
  lines: number[][];
}

export type VenueUnderlay =
  | ({ kind: "image"; url: string; width: number; height: number } & UnderlayPlacement)
  | ({ kind: "vector"; source: "dxf" | "svg"; fileName: string; units: string; bounds: { minX: number; minY: number; maxX: number; maxY: number }; layers: VectorLayer[] } & UnderlayPlacement);

/* ---------------- what the public map reads ---------------- */

/** A court as the public map gets it: the plan court plus its rows in the venue's tournaments. */
export interface PublicVenueCourt extends Omit<VenueCourt, "survey"> {
  links: { slug: string; courtId: string }[];
}

export interface PublicVenue {
  id: string;
  version: number;
  /** The tournament slugs whose courts are on this map (the event group's public tournaments). */
  slugs: string[];
  doc: Omit<VenueDoc, "courts" | "pois" | "walkways"> & {
    courts: PublicVenueCourt[];
    pois: Omit<VenuePoi, "survey">[];
    walkways: { nodes: Omit<WalkNode, "survey">[]; edges: WalkEdge[] };
  };
}

/** One court's live line on the map: "EGY 1–0 USA · 6–4 3–2". */
export interface VenueCourtLive {
  courtKey: string;
  live: boolean;
  slug: string;
  matchId: string | null;
  tieId: string | null;
  /** "EGY 1–0 USA", or "EGY v USA". */
  title: string;
  /** "6–4 3–2", or "Next · 10:00". */
  detail: string | null;
}

export interface VenueLive {
  generatedAt: string;
  courts: VenueCourtLive[];
}
