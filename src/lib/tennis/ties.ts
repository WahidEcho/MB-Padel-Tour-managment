/**
 * Ties: two nations, three rubbers. Pure.
 *
 * A tie is won by the nation that wins the majority of its rubbers, so it is
 * decided the moment one side has two. What happens to the rubber still unplayed
 * then depends on the stage: in the groups it is played anyway (rubbers, sets and
 * games all count in the ranking), in the placement draws it is dropped.
 */
import type { MatchStatus, RubberType, TieFormatConfig } from "../types";

export const DEFAULT_RUBBERS: RubberType[] = ["S2", "S1", "D"];

export const RUBBER_LABELS: Record<RubberType, string> = {
  S1: "No. 1 singles",
  S2: "No. 2 singles",
  D: "Doubles",
};

export const RUBBER_SHORT: Record<RubberType, string> = { S1: "S1", S2: "S2", D: "D" };

/** The order of play for a tournament's ties. */
export function rubberPlan(config: TieFormatConfig | null | undefined): RubberType[] {
  const r = config?.rubbers;
  if (r && r.length === 3 && new Set(r).size === 3 && r.every((x) => x in RUBBER_LABELS)) return r;
  return DEFAULT_RUBBERS;
}

/** What a tie needs to know about one of its rubbers. */
export interface RubberResult {
  id: string;
  status: MatchStatus;
  /** "A" or "B" once the rubber has a winner. */
  winner: "A" | "B" | null;
}

const FINISHED: MatchStatus[] = ["completed", "walkover", "disqualified", "retired"];
const NOT_STARTED: MatchStatus[] = ["scheduled", "ready"];

export function rubberFinished(status: MatchStatus): boolean {
  return FINISHED.includes(status);
}

export interface TieOutcome {
  rubbersA: number;
  rubbersB: number;
  /** The side with a majority of the rubbers, once it has one. */
  winner: "A" | "B" | null;
  status: "scheduled" | "live" | "completed";
  /** Rubbers to drop: decided tie, not started, and dead rubbers are not played at this stage. */
  cancel: string[];
  /** Rubbers dropped earlier that must come back, because the tie is no longer decided. */
  restore: string[];
}

/**
 * The state of a tie from its rubbers. `playDeadRubbers` is true in the groups.
 * Idempotent, and reversible: an undone rubber that un-decides the tie brings its
 * cancelled rubbers back, so an undo never strands a tie with nothing to play.
 */
export function tieOutcome(rubbers: RubberResult[], playDeadRubbers: boolean): TieOutcome {
  let rubbersA = 0;
  let rubbersB = 0;
  for (const r of rubbers) {
    if (!rubberFinished(r.status) || !r.winner) continue;
    if (r.winner === "A") rubbersA++;
    else rubbersB++;
  }
  const majority = Math.floor(rubbers.length / 2) + 1;
  const winner = rubbersA >= majority ? "A" : rubbersB >= majority ? "B" : null;

  const cancel: string[] = [];
  const restore: string[] = [];
  for (const r of rubbers) {
    if (winner && !playDeadRubbers && NOT_STARTED.includes(r.status)) cancel.push(r.id);
    if (r.status === "cancelled" && (!winner || playDeadRubbers)) restore.push(r.id);
  }
  // After the drops and the restores, is anything still to play?
  const pending = rubbers.filter((r) => {
    if (cancel.includes(r.id)) return false;
    if (restore.includes(r.id)) return true;
    return !rubberFinished(r.status) && r.status !== "cancelled";
  });
  const started = rubbers.some((r) => !NOT_STARTED.includes(r.status) && r.status !== "cancelled");
  const status = winner && pending.length === 0 ? "completed" : started ? "live" : "scheduled";
  return { rubbersA, rubbersB, winner, status, cancel, restore };
}

/**
 * Validates a captain's line-up for one side: the two singles players must be
 * different people and the doubles pair two different people, all from the team.
 * Returns the problems, empty when the line-up is good.
 */
export function lineupProblems(
  lineup: { S1?: string | null; S2?: string | null; D?: (string | null)[] | null },
  squad: string[],
): string[] {
  const problems: string[] = [];
  const inSquad = (id: string | null | undefined) => Boolean(id && squad.includes(id));
  if (!inSquad(lineup.S1)) problems.push("Choose the No. 1 singles player.");
  if (!inSquad(lineup.S2)) problems.push("Choose the No. 2 singles player.");
  if (lineup.S1 && lineup.S1 === lineup.S2) problems.push("One player cannot play both singles.");
  const d = (lineup.D ?? []).filter(Boolean) as string[];
  if (d.length !== 2 || !d.every(inSquad)) problems.push("Choose two players for the doubles.");
  else if (d[0] === d[1]) problems.push("The doubles needs two different players.");
  return problems;
}

/** Player ids for a rubber from a side's line-up. */
export function lineupFor(
  type: RubberType,
  lineup: { S1?: string | null; S2?: string | null; D?: (string | null)[] | null },
): string[] | null {
  if (type === "D") {
    const d = (lineup.D ?? []).filter(Boolean) as string[];
    return d.length === 2 ? d : null;
  }
  const p = lineup[type];
  return p ? [p] : null;
}

/**
 * A side as a rubber shows it: the nation with only the players nominated for
 * this rubber, in nomination order. A match with no nominations (not a rubber,
 * or a line-up not yet made) shows the team as it is.
 */
export function withNominees<T extends { players?: P[] }, P extends { id: string }>(
  team: T | undefined,
  ids: string[] | null | undefined,
): T | undefined {
  if (!team || !ids || ids.length === 0) return team;
  const players = ids.map((id) => team.players?.find((p) => p.id === id)).filter((p): p is P => Boolean(p));
  return { ...team, players };
}
