/**
 * Survey mode's "Save this spot", applied to the venue document. Pure.
 *
 * - "move": the feature is placed where the phone is (court centre, POI,
 *   walkway node), through the current anchor, and the fix is kept on it.
 * - "align": the feature stays where the plan has it; the fix becomes a
 *   reference spot, and the anchor and rotation (scale too, with three spots
 *   and "fit scale") are refitted to every reference spot (fit.ts).
 */
import { fitGeo, type AlignPair } from "./fit";
import { geoToLocal } from "./geo";
import type { Pt, SurveyFix, VenueDoc } from "./types";

/** "court:<id>", "poi:<id>", "node:<id>". */
export type FeatureRef = string;

export function featureList(doc: VenueDoc): { ref: FeatureRef; label: string; group: string; point: Pt; survey?: SurveyFix }[] {
  return [
    ...doc.pois.map((p) => ({ ref: `poi:${p.id}`, label: p.name, group: doc.categories.find((c) => c.key === p.category)?.label ?? p.category, point: p.point, survey: p.survey })),
    ...[...doc.courts].sort((a, b) => a.number - b.number).map((c) => ({ ref: `court:${c.id}`, label: `${c.name} (centre)`, group: "Courts", point: c.center, survey: c.survey })),
    ...doc.walkways.nodes.map((n) => ({ ref: `node:${n.id}`, label: n.label ? `${n.label} (${n.id})` : `Walkway point ${n.id}`, group: "Walkway points", point: { x: n.x, y: n.y }, survey: n.survey })),
  ];
}

function alignPairs(doc: VenueDoc): AlignPair[] {
  const out: AlignPair[] = [];
  for (const f of featureList(doc)) if (f.survey?.mode === "align") out.push({ plan: f.point, lat: f.survey.lat, lng: f.survey.lng, accuracy: f.survey.accuracy });
  return out;
}

export function applySurvey(
  doc: VenueDoc,
  ref: FeatureRef,
  fix: Omit<SurveyFix, "mode" | "at"> & { at?: string },
  mode: "move" | "align",
  opts: { fitScale?: boolean } = {},
): { doc: VenueDoc; message: string } | { error: string } {
  const next: VenueDoc = structuredClone(doc);
  const survey: SurveyFix = { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, samples: fix.samples, at: fix.at ?? new Date().toISOString(), mode };
  const [kind, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  const at = geoToLocal(next.geo, fix.lat, fix.lng);
  const round = (p: Pt) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
  let name = "";
  if (kind === "poi") {
    const p = next.pois.find((x) => x.id === id);
    if (!p) return { error: "No such point on the map." };
    if (mode === "move") p.point = round(at);
    p.survey = survey;
    name = p.name;
  } else if (kind === "court") {
    const c = next.courts.find((x) => x.id === id);
    if (!c) return { error: "No such court on the map." };
    if (mode === "move") c.center = round(at);
    c.survey = survey;
    name = c.name;
  } else if (kind === "node") {
    const n = next.walkways.nodes.find((x) => x.id === id);
    if (!n) return { error: "No such walkway point." };
    if (mode === "move") Object.assign(n, round(at));
    n.survey = survey;
    name = n.label ?? `walkway point ${n.id}`;
  } else return { error: "Pick a feature first." };

  if (mode === "move") return { doc: next, message: `${name} placed at the surveyed spot (±${survey.accuracy} m, ${survey.samples} fixes).` };
  const pairs = alignPairs(next);
  const fit = fitGeo(next.geo, pairs, { fitScale: opts.fitScale });
  if (!fit) return { doc: next, message: `${name} saved as a reference spot.` };
  next.geo = fit.geo;
  const rest = pairs.length < 2 ? " Survey one more reference spot to fit the rotation." : "";
  return { doc: next, message: `${name} saved as reference spot ${pairs.length}. The plan is lined up to ${pairs.length === 1 ? "it" : `them (±${fit.rms.toFixed(1)} m)`}.${rest}` };
}
