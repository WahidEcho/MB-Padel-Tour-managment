/**
 * Scoring v2: the match log. Every stored score event of a match in order, in
 * words: points with the score after each, aces, faults and double faults, lets,
 * code violations and their penalties, timers and breaks with how long they ran,
 * the referee's time rulings, walkover, retirement… with when and who entered it.
 * An event that a later Undo took back stays in the log, marked undone.
 *
 * Pure: the route (api/matches/[matchId]/log) reads the rows, the web console,
 * the app and the admin match page draw what this returns.
 */
import type { ScoreState, TeamKey } from "./engine";
import { formatSet } from "./engine";
import { LOG_ONLY_EVENTS } from "./eventGuard";
import { OFFENCE_LABELS, PENALTY_LABELS, type Offence, type Penalty } from "./conduct";
import { clockText, TIMERS, TIME_DECISION_LABELS, isTimerKind, type TimeDecision } from "./timing";

export interface LogEventRow {
  event_number: number;
  event_type: string;
  team_id: string | null;
  payload: Record<string, unknown> | null;
  previous_state: unknown;
  new_state: unknown;
  /** When the device recorded it (created_at_client), else when the server stored it. */
  at: string | null;
  /** Who entered it, already resolved to a name or a role. */
  by: string | null;
  superseded?: boolean;
}

export type LogTag =
  | "point"
  | "ace"
  | "double_fault"
  | "fault"
  | "let"
  | "violation"
  | "timer"
  | "time_ruling"
  | "serve"
  | "undo"
  | "status"
  | "end"
  | "result";

export interface LogEntry {
  n: number;
  at: string | null;
  by: string | null;
  /** "Set 2 · Game 4 · 30–15" (the score after the event), or a heading such as "Between sets". */
  title: string;
  /** "Egypt · ace", "USA · double fault, point Egypt"… */
  detail: string;
  tag: LogTag;
  /** Short label for the tag chip: ACE, FAULT, LET, CHANGEOVER… */
  chip: string | null;
  set: number | null;
  /** Taken back by a later Undo. */
  undone: boolean;
  /** Superseded by a final result entered later. */
  superseded: boolean;
}

function asState(v: unknown): ScoreState | null {
  return v && typeof v === "object" && "teamA" in (v as object) && "teamB" in (v as object) ? (v as ScoreState) : null;
}

/** The point score of a state as the umpire would say it: "30–15", "Deuce", "AD Egypt", or "3–2" in a tie-break. */
function points(s: ScoreState, names: Record<TeamKey, string>): string {
  if (s.isTiebreak) return `${s.teamA.tiebreakPoints}–${s.teamB.tiebreakPoints}`;
  const a = s.teamA.points;
  const b = s.teamB.points;
  if (a === "40" && b === "40") return "Deuce";
  if (a === "AD") return `AD ${names.A}`;
  if (b === "AD") return `AD ${names.B}`;
  return `${a}–${b}`;
}

/** "Set 2 · Game 4 · 30–15": the score after an event, for its row. */
export function scoreTitle(s: ScoreState | null, names: Record<TeamKey, string>): string {
  if (!s) return "Before the match";
  if (s.matchOver) return `Final · ${s.completedSets.map((x) => formatSet(x)).join(" ")}`;
  const game = s.teamA.games + s.teamB.games + 1;
  if (s.isMatchTiebreak) return `Set ${s.currentSet} · Super tie-break · ${points(s, names)}`;
  if (s.isTiebreak) return `Set ${s.currentSet} · Tie-break · ${points(s, names)}`;
  return `Set ${s.currentSet} · Game ${game} · ${s.teamA.games}–${s.teamB.games} · ${points(s, names)}`;
}

const TIMER_CHIP: Record<string, string> = {
  between_points: "25 S",
  changeover: "CHANGEOVER",
  set_break: "SET BREAK",
  break: "BREAK",
  bathroom: "BATHROOM",
  hydration: "HYDRATION",
  medical: "MEDICAL",
  warmup: "WARM-UP",
};

/** Builds the log, oldest first. `teams`: the two sides' ids and names. */
export function buildMatchLog(rows: LogEventRow[], teams: { A: { id: string | null; name: string }; B: { id: string | null; name: string } }): LogEntry[] {
  const names: Record<TeamKey, string> = { A: teams.A.name, B: teams.B.name };
  const keyOf = (id: string | null): TeamKey | null => (id && id === teams.A.id ? "A" : id && id === teams.B.id ? "B" : null);
  const nameOf = (id: string | null) => {
    const k = keyOf(id);
    return k ? names[k] : null;
  };
  const sorted = [...rows].sort((x, y) => x.event_number - y.event_number);
  const out: LogEntry[] = [];
  // Undo takes back the last event that went on the undo stack.
  const stack: LogEntry[] = [];
  for (const r of sorted) {
    const p = r.payload ?? {};
    const next = asState(r.new_state);
    const prev = asState(r.previous_state);
    const team = nameOf(r.team_id);
    const teamKey = keyOf(r.team_id);
    const side = (k: unknown) => (k === "A" || k === "B" ? names[k] : null);
    let title = scoreTitle(next, names);
    let detail = "";
    let tag: LogTag = "status";
    let chip: string | null = null;
    switch (r.event_type) {
      case "MATCH_STARTED":
        title = "Match started";
        detail = next?.servingTeam ? `${names[next.servingTeam]} to serve` : "";
        break;
      case "POINT_AWARDED": {
        tag = "point";
        const server = prev ? (prev.isTiebreak ? null : prev.servingTeam) : null;
        if (p.ace === true) {
          tag = "ace";
          chip = "ACE";
          detail = `${team ?? ""} · ace`;
        } else if (p.double_fault === true) {
          tag = "double_fault";
          chip = "DOUBLE FAULT";
          const faulter = teamKey ? names[teamKey === "A" ? "B" : "A"] : "";
          detail = `${faulter} · double fault, point ${team ?? ""}`;
        } else {
          detail = `Point ${team ?? ""}${server && teamKey === server ? " (server)" : ""}`;
        }
        if (prev && next && next.completedSets.length > prev.completedSets.length) {
          const set = next.completedSets[next.completedSets.length - 1];
          detail += ` · set ${formatSet(set)}`;
        } else if (prev && next && next.teamA.games + next.teamB.games !== prev.teamA.games + prev.teamB.games) {
          detail += " · game";
        }
        break;
      }
      case "FAULT":
        tag = "fault";
        chip = "FAULT";
        detail = `${team ?? ""} · 1st serve fault`;
        break;
      case "LET":
        tag = "let";
        chip = "LET";
        detail = p.kind === "point" ? "Let · point replayed (1st serve)" : `Let · serve replayed (${p.serve === 2 ? "2nd" : "1st"} serve)`;
        break;
      case "SERVE_ORDER":
        tag = "serve";
        title = `Set ${next?.currentSet ?? p.set ?? ""} · serve order`;
        detail = `${side(p.servingTeam) ?? ""} serve first`;
        break;
      case "SERVER_CHANGED":
        tag = "serve";
        detail = "Server corrected";
        break;
      case "CODE_VIOLATION": {
        tag = "violation";
        chip = "VIOLATION";
        const offence = OFFENCE_LABELS[p.offence as Offence] ?? String(p.offence ?? "");
        const penalty = PENALTY_LABELS[p.penalty as Penalty] ?? String(p.penalty ?? "");
        detail = `${team ?? ""} · ${offence} · ${penalty.toLowerCase()}`;
        break;
      }
      case "TIMER_STARTED":
      case "TIMER_STOPPED": {
        tag = "timer";
        const kind = isTimerKind(p.timer) ? p.timer : null;
        chip = kind ? TIMER_CHIP[kind] : "TIMER";
        const label = kind ? TIMERS[kind].label : "Timer";
        const who = side(p.team);
        title = r.event_type === "TIMER_STARTED" ? `${label} started` : `${label} ended`;
        detail = [who, r.event_type === "TIMER_STOPPED" && typeof p.seconds === "number" ? `ran ${clockText(p.seconds)}` : null].filter(Boolean).join(" · ") || "at " + scoreTitle(next, names).replace(/^Set \d+ · /, "");
        break;
      }
      case "TIME_DECISION": {
        tag = "time_ruling";
        const kind = isTimerKind(p.timer) ? p.timer : null;
        chip = "TIME";
        const label = kind ? TIMERS[kind].label : "Time";
        const limit = kind ? TIMERS[kind].limit : null;
        const over = typeof p.seconds === "number" ? clockText(p.seconds) : "";
        title = `${label} · over ${limit !== null ? clockText(limit) : ""}${over ? ` (${over})` : ""}`;
        detail = [side(p.team), TIME_DECISION_LABELS[p.decision as TimeDecision] ?? String(p.decision ?? "")].filter(Boolean).join(" · ");
        break;
      }
      case "UNDO": {
        tag = "undo";
        chip = "UNDO";
        const target = stack.pop();
        if (target) target.undone = true;
        detail = target ? `Took back #${target.n}: ${target.detail || target.title}` : "Undo";
        break;
      }
      case "MATCH_PAUSED":
        detail = "Match paused";
        break;
      case "MATCH_RESUMED":
        detail = "Match resumed";
        break;
      case "MANUAL_SET_END":
        tag = "end";
        detail = `Set ended by the referee · ${team ?? ""}`;
        break;
      case "MATCH_ENDED":
        tag = "end";
        detail = `Result confirmed · ${team ?? ""} wins`;
        break;
      case "FORCE_END":
        tag = "end";
        chip = "ENDED";
        detail = `Match ended by the referee · ${team ?? ""} wins`;
        break;
      case "WALKOVER":
        tag = "end";
        chip = "WALKOVER";
        detail = `Walkover · ${team ?? ""} wins`;
        break;
      case "RETIREMENT":
        tag = "end";
        chip = "RETIRED";
        detail = `Retirement · ${team ?? ""} wins`;
        break;
      case "DISQUALIFICATION":
        tag = "end";
        chip = "DEFAULT";
        detail = `Disqualification · ${team ?? ""} wins`;
        break;
      case "RESULT_ENTERED":
        tag = "result";
        chip = "RESULT";
        detail = `Final result entered · ${team ?? ""} wins`;
        break;
      default:
        detail = r.event_type;
    }
    const entry: LogEntry = {
      n: r.event_number,
      at: r.at,
      by: r.by,
      title,
      detail: detail.replace(/^ · /, "").trim(),
      tag,
      chip,
      set: next?.currentSet ?? null,
      undone: false,
      superseded: Boolean(r.superseded),
    };
    out.push(entry);
    if (r.event_type === "RESULT_ENTERED") stack.length = 0;
    else if (r.event_type !== "UNDO" && !LOG_ONLY_EVENTS.has(r.event_type) && r.previous_state) stack.push(entry);
  }
  return out;
}

/** Aces per side, from the state (stats) — what the screens show when the organiser turned it on. */
export function aceCounts(s: ScoreState | null | undefined): { A: number; B: number } {
  return { A: s?.stats?.aces.A ?? 0, B: s?.stats?.aces.B ?? 0 };
}
