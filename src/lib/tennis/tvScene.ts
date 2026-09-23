/**
 * What a tennis team competition's court TV shows, and when. Pure.
 *
 * One court, one TV. From the live feed and the ties on that court, the wall
 * moves through a day on its own, with nobody at a control desk:
 *
 *   line-up of the next tie → walk-on of each player as a rubber starts →
 *   live score → the rubber won → the tie score between rubbers → …
 *
 * Every decision is made from server-stamped times, so two walls showing the
 * same court, or a wall reloaded mid-walk-on, land on the same frame.
 */
import { pointOutcome, currentServer, type ScoreState, type TeamKey } from "../scoring/engine";
import type { MatchRules, RubberType } from "../types";

/** A rubber on the wall: the feed's live fields plus its place in the tie. */
export interface SceneRubber {
  id: string;
  tie_id: string;
  rubber_no: number;
  rubber_type: RubberType;
  court_id: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  winner_team_id: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  last_event_number: number;
}

export interface SceneTie {
  id: string;
  court_id: string | null;
  tie_order: number;
  team_a_id: string | null;
  team_b_id: string | null;
}

export const WALKON = {
  /** Each player's card holds this long; a doubles pair shares one card. */
  perSideMs: 7_000,
  /** Both sides, then the wall goes to the score. */
  totalMs: 14_000,
};
export const RUBBER_WON_MS = 12_000;
/** A finished tie stays on its court's wall this long before the next line-up. */
export const TIE_FINAL_MS = 5 * 60_000;

export type CourtScene =
  | { kind: "idle" }
  | { kind: "lineup"; tieId: string }
  | { kind: "walkon"; tieId: string; matchId: string; side: TeamKey; elapsedMs: number }
  | { kind: "live"; tieId: string; matchId: string }
  | { kind: "rubber_won"; tieId: string; matchId: string; elapsedMs: number }
  | { kind: "tie_score"; tieId: string; final: boolean };

const LIVE = ["live", "paused"];
const DONE = ["completed", "walkover", "retired", "disqualified"];
const since = (iso: string | null, now: number) => (iso ? now - Date.parse(iso) : Number.POSITIVE_INFINITY);

/**
 * The scene for one court. `replay` is the operator's REPLAY ENTRANCE: a walk-on
 * again for a live rubber, until the next point is scored.
 */
export function courtScene(
  courtId: string,
  ties: SceneTie[],
  rubbers: SceneRubber[],
  now: number,
  replay: { match_id: string; at: string; event_number?: number } | null = null,
): CourtScene {
  const here = rubbers.filter((r) => r.court_id === courtId);

  // 1. A rubber in play on this court.
  const live = here.find((r) => LIVE.includes(r.status));
  if (live) {
    const replayed = replay?.match_id === live.id && (replay.event_number ?? 0) >= live.last_event_number;
    const t = replayed ? since(replay!.at, now) : since(live.started_at, now);
    const fresh = replayed || live.last_event_number <= 1;
    if (fresh && t >= 0 && t < WALKON.totalMs) {
      return { kind: "walkon", tieId: live.tie_id, matchId: live.id, side: t < WALKON.perSideMs ? "A" : "B", elapsedMs: t % WALKON.perSideMs };
    }
    return { kind: "live", tieId: live.tie_id, matchId: live.id };
  }

  // 2. A rubber that has just finished.
  const justDone = here
    .filter((r) => DONE.includes(r.status) && since(r.ended_at, now) < RUBBER_WON_MS)
    .sort((a, b) => since(a.ended_at, now) - since(b.ended_at, now))[0];
  if (justDone) return { kind: "rubber_won", tieId: justDone.tie_id, matchId: justDone.id, elapsedMs: since(justDone.ended_at, now) };

  const courtTies = ties.filter((t) => t.court_id === courtId).sort((a, b) => a.tie_order - b.tie_order);
  const rubbersOf = (tieId: string) => rubbers.filter((r) => r.tie_id === tieId);
  const started = (tieId: string) => rubbersOf(tieId).some((r) => !["scheduled", "ready", "cancelled"].includes(r.status));
  const finished = (tieId: string) => rubbersOf(tieId).every((r) => DONE.includes(r.status) || r.status === "cancelled");

  // 3. A tie under way between rubbers: the tie score, and what is next.
  const between = courtTies.find((t) => started(t.id) && !finished(t.id));
  if (between) return { kind: "tie_score", tieId: between.id, final: false };

  // 4. A tie finished a little while ago keeps the wall for its final score.
  const lastEnd = (tieId: string) =>
    Math.max(...rubbersOf(tieId).map((r) => (r.ended_at ? Date.parse(r.ended_at) : 0)));
  const recent = courtTies
    .filter((t) => started(t.id) && finished(t.id) && now - lastEnd(t.id) < TIE_FINAL_MS)
    .sort((a, b) => lastEnd(b.id) - lastEnd(a.id))[0];
  if (recent) return { kind: "tie_score", tieId: recent.id, final: true };

  // 5. Otherwise the next tie on this court, as its line-up.
  const next = courtTies.find((t) => !started(t.id) && t.team_a_id && t.team_b_id);
  if (next) return { kind: "lineup", tieId: next.id };
  return { kind: "idle" };
}

export type Callout = "Match point" | "Set point" | "Break point" | "Deciding point" | "Tie-break" | "Match tie-break";

/**
 * The call above the score, if any: match point beats set point beats break
 * point. A deciding point (no-ad at 40-40) is announced as such; the first point
 * of a tie-break says which kind it is.
 */
export function callout(state: ScoreState | null | undefined, rules: MatchRules): Callout | null {
  if (!state || state.matchOver) return null;
  const server = currentServer(state);
  const receiver: TeamKey | null = server ? (server === "A" ? "B" : "A") : null;
  const sides: TeamKey[] = receiver && server ? [receiver, server] : ["A", "B"];
  const outcomes = sides.map((s) => ({ side: s, o: pointOutcome(state, s, rules) }));
  if (outcomes.some((x) => x.o.winsMatch)) return "Match point";
  if (outcomes.some((x) => x.o.winsSet)) return "Set point";
  if (!state.isTiebreak && receiver && pointOutcome(state, receiver, rules).winsGame) {
    return rules.decidingPoint && state.teamA.points === "40" && state.teamB.points === "40" ? "Deciding point" : "Break point";
  }
  if (rules.decidingPoint && !state.isTiebreak && state.teamA.points === "40" && state.teamB.points === "40") return "Deciding point";
  if (state.isTiebreak && state.teamA.tiebreakPoints + state.teamB.tiebreakPoints === 0) {
    return state.isMatchTiebreak ? "Match tie-break" : "Tie-break";
  }
  return null;
}

/** The tie score from its rubbers as they stand in the feed. */
export function tieScore(rubbers: SceneRubber[], teamA: string | null): [number, number] {
  let a = 0;
  let b = 0;
  for (const r of rubbers) {
    if (!DONE.includes(r.status) || !r.winner_team_id) continue;
    if (r.winner_team_id === teamA) a++;
    else b++;
  }
  return [a, b];
}
