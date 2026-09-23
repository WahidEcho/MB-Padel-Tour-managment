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

/** The longest delay (or bringing forward) the order of play takes in one go: a day's play. */
export const MAX_DELAY_MINUTES = 12 * 60;

/** A scheduled time moved by some minutes; null stays null. */
export function shiftTime(iso: string | null, minutes: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at + minutes * 60_000).toISOString() : iso;
}

/** Where the event is played: order-of-play times are entered and shown in this zone. */
export const EVENT_TIME_ZONE = "Africa/Cairo";
/** A tie's rubbers follow one another; each is expected about this long after the one before. */
export const RUBBER_GAP_MINUTES = 90;

/** The zone's offset from UTC, in minutes, at an instant. */
function offsetMinutes(atMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(atMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60_000);
}

/**
 * A wall-clock time in the event's zone ("2026-11-02T09:30", as a datetime-local
 * input gives it) as an ISO instant. The server runs in UTC, so reading the input
 * as a plain Date would put every tie two hours out in Cairo. Null when unreadable.
 */
export function zonedToIso(local: string, timeZone = EVENT_TIME_ZONE): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Twice, so an instant next to a daylight-saving change settles on its own offset.
  let at = guess - offsetMinutes(guess, timeZone) * 60_000;
  at = guess - offsetMinutes(at, timeZone) * 60_000;
  return new Date(at).toISOString();
}

/** An instant as the event zone's wall clock, for a datetime-local input. */
export function isoToZonedInput(iso: string | null, timeZone = EVENT_TIME_ZONE): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  return new Date(at + offsetMinutes(at, timeZone) * 60_000).toISOString().slice(0, 16);
}
