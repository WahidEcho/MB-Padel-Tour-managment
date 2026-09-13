/**
 * What each court on a screen is showing right now.
 *
 * The screen used to filter matches to those live or paused and draw a card for
 * each, so a match vanished on the very next poll after it finished — the result
 * animation and the hold after it could never render. The card is resolved per
 * COURT instead: a court is always there, and what it shows moves through a
 * finished result, live play, a rested result, the next fixture and idle.
 *
 * Pure and framework-free.
 */
import type { Match } from "../types";
import { RESULT } from "./timeline";

export type CourtSlotKind = "hold" | "live" | "rest" | "next" | "idle";

/** The only fields resolution reads, so the live feed's lean rows qualify. */
export type SlotMatch = Pick<
  Match,
  "id" | "court_id" | "status" | "started_at" | "ended_at" | "scheduled_time" | "match_order"
>;

export interface CourtSlot<M extends SlotMatch = SlotMatch> {
  courtId: string;
  kind: CourtSlotKind;
  match: M | null;
}

export interface CourtSlotOptions {
  /** A confirmed result owns the card for this long, even over a new live match. */
  resultHoldMs?: number;
  /** After the hold, a recent result is still shown, stilled, for this long. */
  resultRestMs?: number;
}

const FINISHED = new Set(["completed", "walkover", "retired", "disqualified"]);

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Resolves every court, in the order the courts were given.
 *
 * Precedence per court:
 *   hold  a result confirmed within the hold window. Outranks a live match on the
 *         same court, so the floor is absolute: a referee starting the next match
 *         straight away does not cut off the previous one's result.
 *   live  a live or paused match, the most recently started if several.
 *   rest  a result from within the rest window, shown still.
 *   next  the court's next fixture, by scheduled time then match order.
 *   idle  nothing to show.
 *
 * Every hold is scoped to the card's own court. The reference implementation
 * looked across all rounds for the most recent result, so one court finishing
 * would pull a different court's card onto its result.
 */
export function courtSlots<M extends SlotMatch>(
  courtIds: string[],
  matches: M[],
  nowMs: number,
  opts: CourtSlotOptions = {},
): CourtSlot<M>[] {
  const holdMs = opts.resultHoldMs ?? RESULT.holdMs;
  const restMs = opts.resultRestMs ?? 300_000;

  return courtIds.map((courtId) => {
    const onCourt = matches.filter((m) => m.court_id === courtId && m.status !== "cancelled");

    const finished = onCourt
      .filter((m) => FINISHED.has(m.status) && m.ended_at)
      .sort((a, b) => time(b.ended_at) - time(a.ended_at));
    const latestResult = finished[0] ?? null;
    const resultAge = latestResult ? Math.max(0, nowMs - time(latestResult.ended_at)) : Infinity;

    if (latestResult && resultAge < holdMs) return { courtId, kind: "hold" as const, match: latestResult };

    const live = onCourt
      .filter((m) => m.status === "live" || m.status === "paused")
      .sort((a, b) => time(b.started_at) - time(a.started_at))[0];
    if (live) return { courtId, kind: "live" as const, match: live };

    if (latestResult && resultAge < restMs) return { courtId, kind: "rest" as const, match: latestResult };

    const next = onCourt
      .filter((m) => m.status === "scheduled" || m.status === "ready")
      .sort(
        (a, b) =>
          (time(a.scheduled_time) || Infinity) - (time(b.scheduled_time) || Infinity) ||
          a.match_order - b.match_order,
      )[0];
    if (next) return { courtId, kind: "next" as const, match: next };

    return { courtId, kind: "idle" as const, match: null };
  });
}
