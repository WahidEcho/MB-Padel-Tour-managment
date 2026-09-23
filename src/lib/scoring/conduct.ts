/**
 * Code violations and the point penalty system (ITF Rules of Tennis, Code of
 * Conduct). Pure: the referee screen records a violation as a scoring event whose
 * new state carries the penalty, so an undo takes the penalty back with it.
 *
 * Two ladders, kept per team:
 * - Code violations: warning, point penalty, then a game penalty for each one
 *   after that. A default is always the chair's call, never automatic.
 * - Time violations (between points): a warning, then a point penalty each time.
 *   A server's second time violation is really a fault; the app records it as a
 *   point penalty only when the receiver is at fault, and as a fault otherwise,
 *   because the app does not score first and second serves.
 */
import { awardGame, awardPoint, opponent, type ScoreState, type TeamKey } from "./engine";
import type { ScoringConfig } from "../types";

export type Offence =
  | "time"
  | "ball_abuse"
  | "racket_abuse"
  | "audible_obscenity"
  | "visible_obscenity"
  | "verbal_abuse"
  | "physical_abuse"
  | "coaching"
  | "unsportsmanlike";

export type Penalty = "warning" | "point" | "game" | "fault";

export interface RecordedViolation {
  team: TeamKey;
  offence: Offence;
  penalty: Penalty;
  /** Which player, by index into the team's players, when the referee named one. */
  player?: number | null;
}

export const OFFENCE_LABELS: Record<Offence, string> = {
  time: "Time violation",
  ball_abuse: "Ball abuse",
  racket_abuse: "Racket abuse",
  audible_obscenity: "Audible obscenity",
  visible_obscenity: "Visible obscenity",
  verbal_abuse: "Verbal abuse",
  physical_abuse: "Physical abuse",
  coaching: "Coaching",
  unsportsmanlike: "Unsportsmanlike conduct",
};

export const PENALTY_LABELS: Record<Penalty, string> = {
  warning: "Warning",
  point: "Point penalty",
  game: "Game penalty",
  fault: "Fault",
};

/**
 * The penalty the next violation of this kind earns. `serving` says whether the
 * offending team is serving, which only matters for a repeat time violation.
 */
export function nextPenalty(state: ScoreState, team: TeamKey, offence: Offence, serving: boolean): Penalty {
  const past = (state.violations ?? []).filter((v) => v.team === team);
  if (offence === "time") {
    const times = past.filter((v) => v.offence === "time").length;
    if (times === 0) return "warning";
    return serving ? "fault" : "point";
  }
  const codes = past.filter((v) => v.offence !== "time").length;
  if (codes === 0) return "warning";
  if (codes === 1) return "point";
  return "game";
}

/** The state after the violation and its penalty. A point or game goes to the opponents. */
export function applyViolation(
  state: ScoreState,
  violation: RecordedViolation,
  config: ScoringConfig,
): ScoreState {
  const beneficiary = opponent(violation.team);
  let next = state;
  if (violation.penalty === "point") next = awardPoint(state, beneficiary, config);
  else if (violation.penalty === "game") next = awardGame(state, beneficiary, config);
  // awardPoint/awardGame return copies; a warning or fault must not share the
  // caller's object either, or the history entry and the new state alias.
  if (next === state) next = JSON.parse(JSON.stringify(state)) as ScoreState;
  next.violations = [...(state.violations ?? []), violation];
  return next;
}
