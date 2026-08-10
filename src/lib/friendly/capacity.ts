/**
 * Session capacity estimation.
 *
 * Answers the organiser's question before a session starts: with this many
 * courts, this many players and a two-hour window, how many rounds actually
 * fit, and will everyone get a fair share of court time?
 *
 * Pure module: no database, no framework.
 */
import { matchesPerRound } from "./scheduler";

/** Default match length for a single set to 6. */
export const DEFAULT_MATCH_MINUTES_ONE_SET = 30;
/** Default match length for best of three sets. */
export const DEFAULT_MATCH_MINUTES_BEST_OF_THREE = 60;
/** Changeover, court sweep and getting the next four on court. */
export const DEFAULT_TURNOVER_MINUTES = 5;
/** Standard friendly session length. */
export const DEFAULT_SESSION_MINUTES = 120;

export interface CapacityInput {
  durationMinutes: number;
  expectedMatchMinutes: number;
  turnoverMinutes: number;
  courts: number;
  playerCount: number;
}

export interface CapacityEstimate {
  /** Rounds that fit inside the window. */
  roundsThatFit: number;
  /** Concurrent matches each round (court- or player-limited). */
  matchesPerRound: number;
  totalMatches: number;
  /** Court slots per player, averaged — may be fractional. */
  matchesPerPlayer: number;
  /** Rest turns per player, averaged. */
  restTurnsPerPlayer: number;
  /** Minutes consumed by the planned rounds. */
  minutesUsed: number;
  /** True when every player gets the same number of matches. */
  evenlyBalanced: boolean;
  warnings: string[];
}

export function defaultMatchMinutes(setsToWinMatch: number): number {
  return setsToWinMatch > 1
    ? DEFAULT_MATCH_MINUTES_BEST_OF_THREE
    : DEFAULT_MATCH_MINUTES_ONE_SET;
}

export function estimateCapacity(input: CapacityInput): CapacityEstimate {
  const {
    durationMinutes,
    expectedMatchMinutes,
    turnoverMinutes,
    courts,
    playerCount,
  } = input;

  const warnings: string[] = [];
  const slotMinutes = Math.max(1, expectedMatchMinutes + turnoverMinutes);
  const roundsThatFit = Math.max(0, Math.floor(durationMinutes / slotMinutes));
  const perRound = matchesPerRound(playerCount, courts);

  if (playerCount < 4) {
    warnings.push("At least 4 approved players are needed to schedule a match.");
  }
  if (courts < 1) {
    warnings.push("No active courts — add a court before generating a schedule.");
  }
  if (roundsThatFit === 0 && durationMinutes > 0) {
    warnings.push(
      `A ${expectedMatchMinutes}-minute match plus ${turnoverMinutes} minutes turnover does not fit in ${durationMinutes} minutes.`
    );
  }

  const totalMatches = perRound * roundsThatFit;
  const playerSlots = totalMatches * 4;
  const matchesPerPlayer = playerCount > 0 ? playerSlots / playerCount : 0;
  const restTurnsPerPlayer = Math.max(0, roundsThatFit - matchesPerPlayer);
  const evenlyBalanced = playerCount > 0 && playerSlots % playerCount === 0;

  if (playerCount >= 4 && playerCount % 4 !== 0) {
    warnings.push(
      `${playerCount} players is not a multiple of 4, so ${playerCount % 4} player(s) rest each round on a rotation.`
    );
  }
  if (perRound > 0 && perRound < courts) {
    warnings.push(
      `Only ${perRound} of ${courts} courts can be filled with ${playerCount} players.`
    );
  }
  if (perRound === courts && playerCount > courts * 4) {
    const idle = playerCount - courts * 4;
    warnings.push(
      `${idle} player(s) rest every round — courts, not players, are the limit.`
    );
  }
  if (roundsThatFit > 0 && !evenlyBalanced) {
    warnings.push(
      "Court time cannot be split exactly evenly; the scheduler keeps matches within one of each other."
    );
  }

  return {
    roundsThatFit,
    matchesPerRound: perRound,
    totalMatches,
    matchesPerPlayer,
    restTurnsPerPlayer,
    minutesUsed: roundsThatFit * slotMinutes,
    evenlyBalanced,
    warnings,
  };
}

/**
 * Minimum players needed to keep every court busy.
 * Useful for the registration screen's target number.
 */
export function playersToFillCourts(courts: number): number {
  return Math.max(0, courts) * 4;
}
