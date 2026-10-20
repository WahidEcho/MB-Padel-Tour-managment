/**
 * Live navigation: where the walker is along the route, which step is next,
 * whether they have left the route (re-route) or arrived. Pure; fed with
 * positions already converted to plan metres.
 */
import { closestOnSegment, dist } from "./geo";
import type { Step } from "./directions";
import { formatDistance } from "./directions";
import { walkingSeconds } from "./route";
import type { Pt } from "./types";

export interface RouteProgress {
  /** Metres walked along the route (of the nearest point on it). */
  along: number;
  /** Metres from the route. */
  offset: number;
  remaining: number;
  /** The nearest point on the route. */
  onRoute: Pt;
  /** Index of the next step (the first not yet passed). */
  stepIndex: number;
  /** Metres to that step's end. */
  toStep: number;
}

/** Cumulative distance at each route point. */
export function cumulative(points: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + dist(points[i - 1], points[i]));
  return out;
}

export function progressOn(points: Pt[], steps: Step[], p: Pt, hint = 0): RouteProgress {
  const cum = cumulative(points);
  let best = { along: 0, offset: Infinity, onRoute: points[0] ?? p };
  for (let i = 1; i < points.length; i++) {
    const c = closestOnSegment(p, points[i - 1], points[i]);
    // Prefer segments not behind the walker's last known place (a route that doubles back).
    const along = cum[i - 1] + c.t * (cum[i] - cum[i - 1]);
    const penalty = along + 5 < hint ? 8 : 0;
    if (c.distance + penalty < best.offset) best = { along, offset: c.distance + penalty, onRoute: c.point };
  }
  if (points.length < 2) best.offset = points[0] ? dist(points[0], p) : 0;
  else best.offset = dist(best.onRoute, p);
  const total = cum[cum.length - 1] ?? 0;
  let stepIndex = steps.length - 1;
  for (let i = 0; i < steps.length; i++) {
    if (cum[steps[i].index] - 3 > best.along) {
      stepIndex = i;
      break;
    }
  }
  const toStep = Math.max(0, (cum[steps[stepIndex]?.index ?? cum.length - 1] ?? total) - best.along);
  return { along: best.along, offset: best.offset, remaining: Math.max(0, total - best.along), onRoute: best.onRoute, stepIndex, toStep };
}

/** How far from the route counts as off it, given the fix's accuracy. */
export function offRouteThreshold(accuracy: number | null | undefined): number {
  const a = accuracy ?? 15;
  return Math.min(45, Math.max(14, a * 1.2 + 6));
}

/** Within this of the destination is "arrived". */
export function arrivalRadius(accuracy: number | null | undefined): number {
  return Math.min(15, Math.max(8, (accuracy ?? 10) * 0.6));
}

export interface NavState {
  along: number;
  offCount: number;
  arrived: boolean;
  /** Last progress, for display. */
  progress: RouteProgress | null;
}

export const NAV_START: NavState = { along: 0, offCount: 0, arrived: false, progress: null };

export type NavEvent = "progress" | "reroute" | "arrived";

/** Fixes in a row off the route before re-routing (one wild GPS jump is not a detour). */
export const OFF_ROUTE_FIXES = 2;

/**
 * One position fix: the new state, and what the map should do: keep going, plan
 * a new route from here (left the route), or say "You've arrived".
 */
export function navStep(state: NavState, route: { points: Pt[]; steps: Step[]; target: { point: Pt } }, p: Pt, accuracy?: number | null): { state: NavState; event: NavEvent } {
  if (state.arrived) return { state, event: "arrived" };
  const progress = progressOn(route.points, route.steps, p, state.along);
  const end = route.points[route.points.length - 1] ?? route.target.point;
  const radius = arrivalRadius(accuracy);
  if (progress.remaining <= radius || dist(p, end) <= radius) {
    return { state: { ...state, arrived: true, progress }, event: "arrived" };
  }
  const off = progress.offset > offRouteThreshold(accuracy);
  const offCount = off ? state.offCount + 1 : 0;
  const along = Math.max(state.along, off ? state.along : progress.along);
  if (offCount >= OFF_ROUTE_FIXES) return { state: { along: 0, offCount: 0, arrived: false, progress }, event: "reroute" };
  return { state: { along, offCount, arrived: false, progress }, event: "progress" };
}

/** "120 m · 2 min" for the route card. */
export function remainingLabel(m: number): string {
  const s = walkingSeconds(m);
  return `${formatDistance(m)} · ${s < 45 ? "under a minute" : `${Math.round(s / 60)} min`}`;
}
