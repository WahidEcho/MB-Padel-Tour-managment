/**
 * Step-by-step walking directions from a route's points: "Walk 40 m, then turn
 * left towards Court 7". Pure; plan frame is right-handed (a positive turn is
 * to the left).
 */
import { dist } from "./geo";
import type { Pt } from "./types";

export type Turn = "left" | "right" | "slight_left" | "slight_right" | "sharp_left" | "sharp_right" | "u_turn";

export interface Step {
  kind: "walk" | "arrive";
  text: string;
  /** Metres walked in this step. */
  distance: number;
  /** Where the step ends (the turn, or the destination). */
  at: Pt;
  /** Index into the route's points of that place. */
  index: number;
  turn?: Turn;
}

/** Turns gentler than this are walked straight on (and merged). */
export const STRAIGHT_DEG = 28;
/** Legs shorter than this are folded into the next one (a kink in a path is not a step). */
export const MIN_LEG_M = 4;

/** Rounded the way people say it: 7 m, 35 m, 120 m. */
export function formatDistance(m: number): string {
  if (m < 10) return `${Math.max(1, Math.round(m))} m`;
  if (m < 100) return `${Math.round(m / 5) * 5} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 45) return "under a minute";
  const min = Math.round(seconds / 60);
  return `${min} min`;
}

const heading = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);

/** Signed turn in degrees from leg (a→b) to leg (b→c): positive is left. */
export function turnAngle(a: Pt, b: Pt, c: Pt): number {
  let d = ((heading(b, c) - heading(a, b)) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export function turnOf(deg: number): Turn | null {
  const a = Math.abs(deg);
  if (a < STRAIGHT_DEG) return null;
  const side = deg > 0 ? "left" : "right";
  if (a < 60) return `slight_${side}` as Turn;
  if (a < 135) return side;
  if (a < 165) return `sharp_${side}` as Turn;
  return "u_turn";
}

export const TURN_WORDS: Record<Turn, string> = {
  left: "turn left",
  right: "turn right",
  slight_left: "bear left",
  slight_right: "bear right",
  sharp_left: "turn sharp left",
  sharp_right: "turn sharp right",
  u_turn: "turn around",
};

interface Leg {
  from: number;
  to: number;
  length: number;
}

/** The route's legs: straight-ish runs between real turns. */
export function legsOf(points: Pt[]): Leg[] {
  if (points.length < 2) return [];
  const legs: Leg[] = [{ from: 0, to: 1, length: dist(points[0], points[1]) }];
  for (let i = 2; i < points.length; i++) {
    const last = legs[legs.length - 1];
    const seg = dist(points[i - 1], points[i]);
    const turn = turnOf(turnAngle(points[last.from], points[i - 1], points[i]));
    if (!turn) {
      last.to = i;
      last.length += seg;
    } else legs.push({ from: i - 1, to: i, length: seg });
  }
  // Fold very short legs into the following one.
  for (let i = 0; i < legs.length - 1; ) {
    if (legs[i].length < MIN_LEG_M) {
      legs[i + 1] = { from: legs[i].from, to: legs[i + 1].to, length: legs[i].length + legs[i + 1].length };
      legs.splice(i, 1);
    } else i++;
  }
  return legs;
}

export interface Landmark {
  name: string;
  point: Pt;
}

/** A named place near where a leg ends, to say where the turn leads. */
function towards(end: Pt, landmarks: Landmark[], destination: string, isLast: boolean): string | null {
  if (isLast) return destination;
  let best: Landmark | null = null;
  let bestD = 28;
  for (const l of landmarks) {
    const d = dist(l.point, end);
    if (d < bestD) {
      best = l;
      bestD = d;
    }
  }
  return best?.name ?? null;
}

/** Which side the destination is on, walking the last leg. */
export function sideOf(a: Pt, b: Pt, p: Pt): "left" | "right" | "ahead" {
  const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const len = dist(a, b) * dist(b, p);
  if (len === 0 || Math.abs(cr) / len < 0.35) return "ahead";
  return cr > 0 ? "left" : "right";
}

export function directionsFor(points: Pt[], target: { name: string; point: Pt; kind?: string }, landmarks: Landmark[] = []): Step[] {
  const legs = legsOf(points);
  const steps: Step[] = [];
  const end = points[points.length - 1];
  if (!legs.length) {
    return [{ kind: "arrive", text: `You've arrived at ${target.name}.`, distance: 0, at: end ?? target.point, index: Math.max(0, points.length - 1) }];
  }
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const walk = `Walk ${formatDistance(leg.length)}`;
    if (i < legs.length - 1) {
      const next = legs[i + 1];
      const turn = turnOf(turnAngle(points[Math.max(leg.from, leg.to - 1)], points[leg.to], points[leg.to + 1] ?? points[next.to])) ?? "left";
      const where = towards(points[next.to], landmarks, target.name, i + 1 === legs.length - 1);
      steps.push({
        kind: "walk",
        text: `${walk}, then ${TURN_WORDS[turn]}${where ? ` towards ${where}` : ""}`,
        distance: leg.length,
        at: points[leg.to],
        index: leg.to,
        turn,
      });
    } else {
      const side = sideOf(points[Math.max(leg.from, leg.to - 1)], points[leg.to], target.point);
      const sideText = side === "ahead" ? "" : ` on your ${side}`;
      steps.push({ kind: "walk", text: `${walk} to ${target.name}${sideText}`, distance: leg.length, at: points[leg.to], index: leg.to });
    }
  }
  steps.push({ kind: "arrive", text: `You've arrived at ${target.name}.`, distance: 0, at: end, index: points.length - 1 });
  return steps;
}
