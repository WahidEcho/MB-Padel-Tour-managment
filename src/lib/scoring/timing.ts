/**
 * Scoring v2: timers and changes of ends, per the ITF Rules of Tennis 2026
 * (Rule 10, change of ends, p. 7; Rule 29a, continuous play, pp. 13–14). Pure.
 *
 * - Ends change after the 1st, 3rd and every following odd game of each set, and at
 *   the end of a set when its games add up to an odd number; in a tie-break every six
 *   points (endsChange in engine.ts).
 * - 25 seconds between points; 90 seconds at a change of ends, but none after the
 *   first game of a set or during a tie-break; 120 seconds between sets.
 *
 * The console runs the timers; changeovers, set breaks and the breaks the referee
 * starts from More are recorded as TIMER_STARTED / TIMER_STOPPED events (the state
 * carries the running timer in `clock`, so venue screens and the app can show it),
 * and an overrun the referee rules on is a TIME_DECISION event. None of these change
 * the score, so none of them is undone by Undo. A step that moves the score closes a
 * running timer in the state (engine.ts drops `clock`), and the state an Undo goes back
 * to never carries one (`withoutClock`), so an Undo cannot resurrect an old clock.
 */
import { endsChange, type ScoreState, type TeamKey } from "./engine";
import { scoreKey } from "./serve";

export type TimerKind = "between_points" | "changeover" | "set_break" | "break" | "bathroom" | "hydration";
export const TIMER_KINDS: readonly TimerKind[] = ["between_points", "changeover", "set_break", "break", "bathroom", "hydration"];

export interface TimerDef {
  label: string;
  /** Seconds. "limit": the time allowed, red after it with a ruling; "warn": a stopwatch that warns; null: open. */
  limit: number | null;
  mode: "limit" | "warn" | "open";
  /** Over the limit the referee rules: code violation, warning or no action. */
  ruling: boolean;
  /** The rule it comes from, for the tappable reference. */
  rule: { label: string; href: string } | null;
}

export const ITF_RULES_PDF = "https://www.itftennis.com/media/7221/2026-rules-of-tennis-english.pdf";
const RULE_29A = { label: "ITF Rule 29a · p. 14", href: "/regulations/itf-rules-of-tennis/29a" };

export const TIMERS: Record<TimerKind, TimerDef> = {
  between_points: { label: "Between points", limit: 25, mode: "limit", ruling: true, rule: RULE_29A },
  changeover: { label: "Changeover", limit: 90, mode: "limit", ruling: true, rule: RULE_29A },
  set_break: { label: "Set break", limit: 120, mode: "limit", ruling: true, rule: RULE_29A },
  break: { label: "Break", limit: null, mode: "open", ruling: false, rule: null },
  bathroom: { label: "Bathroom break", limit: 600, mode: "warn", ruling: false, rule: null },
  hydration: { label: "Hydration break", limit: 600, mode: "limit", ruling: false, rule: null },
};

export const isTimerKind = (v: unknown): v is TimerKind => typeof v === "string" && (TIMER_KINDS as readonly string[]).includes(v);

export interface TimerView {
  kind: TimerKind;
  /** Whole seconds since the timer started. */
  elapsed: number;
  limit: number | null;
  /** Past the limit: red (limit), a warning (warn). Never for an open stopwatch. */
  over: boolean;
  overBy: number;
  /** Show the ruling row: code violation / warning / no action. */
  ruling: boolean;
  /** "1:38" */
  text: string;
  /** 0..1 of the limit used (1 once over); null for an open stopwatch. */
  progress: number | null;
}

export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What a running timer shows after `elapsedMs`. Timers count up: 0:01 … 0:25 … */
export function timerView(kind: TimerKind, elapsedMs: number): TimerView {
  const def = TIMERS[kind];
  const elapsed = Math.max(0, Math.floor(elapsedMs / 1000));
  const over = def.limit !== null && elapsed > def.limit;
  return {
    kind,
    elapsed,
    limit: def.limit,
    over,
    overBy: over && def.limit !== null ? elapsed - def.limit : 0,
    ruling: over && def.ruling,
    text: clockText(elapsed),
    progress: def.limit === null ? null : Math.min(1, elapsed / def.limit),
  };
}

export interface AfterPoint {
  /** The players change ends now (auto swap of the referee's left and right). */
  changeEnds: boolean;
  /** The timer that starts on its own: a changeover, a set break, or the 25 s between points. */
  timer: TimerKind | null;
}

/**
 * What follows a step that moved the score: a set break (120 s), a changeover with
 * rest (90 s), or else the 25 s between points — also at a change of ends with no
 * rest (after a set's first game, every six points of a tie-break). Nothing when the
 * score did not move or the match is over.
 */
export function afterScoreChange(prev: ScoreState, next: ScoreState): AfterPoint {
  if (next.matchOver || scoreKey(prev) === scoreKey(next)) return { changeEnds: false, timer: null };
  const e = endsChange(prev, next);
  if (e.kind === "set_break") return { changeEnds: e.changeEnds, timer: "set_break" };
  if (e.kind === "changeover" && e.restSeconds > 0) return { changeEnds: true, timer: "changeover" };
  return { changeEnds: e.changeEnds, timer: "between_points" };
}

/**
 * How many times the players have changed ends so far in the match, from the
 * score alone (so an Undo puts the referee's left and right back by itself).
 * Per set: after every odd game (the set's last game included when the total is
 * odd: a 7-6 set has 13), plus every six points of a tie-break before its last.
 */
export function endChangesSoFar(s: ScoreState): number {
  let n = 0;
  for (const set of s.completedSets) {
    const games = set.teamAGames + set.teamBGames;
    // A match tie-break counts as one game (recorded 1-0).
    n += Math.floor((games + 1) / 2);
    if (set.tiebreak) {
      const pts = set.tiebreak.a + set.tiebreak.b;
      n += Math.floor((pts - 1) / 6);
    }
  }
  // When the match is over the last set is already in completedSets.
  if (!s.matchOver) {
    const games = s.teamA.games + s.teamB.games;
    n += s.isMatchTiebreak ? 0 : Math.floor((games + 1) / 2);
    if (s.isTiebreak) n += Math.floor((s.teamA.tiebreakPoints + s.teamB.tiebreakPoints) / 6);
  }
  return n;
}

/** The referee's view: is team A on the right? Auto swap follows the ends; a manual swap flips it. */
export function sidesSwapped(s: ScoreState | null, opts: { auto: boolean; manual: boolean }): boolean {
  const auto = opts.auto && s ? endChangesSoFar(s) % 2 === 1 : false;
  return auto !== opts.manual;
}

/** Starts a timer in the state (TIMER_STARTED), at the current score. */
export function startClock(prev: ScoreState, kind: TimerKind, startedAt: string, team: TeamKey | null = null): ScoreState {
  const next = JSON.parse(JSON.stringify(prev)) as ScoreState;
  next.clock = { kind, startedAt, at: scoreKey(prev), ...(team ? { team } : {}) };
  return next;
}

/** Stops the running timer (TIMER_STOPPED). */
export function stopClock(prev: ScoreState): ScoreState {
  const next = JSON.parse(JSON.stringify(prev)) as ScoreState;
  delete next.clock;
  return next;
}

/**
 * The state with no recorded timer in it (the same object when it has none). Undo
 * targets go through this: a timer is never undone (it is log-only), so the state an
 * Undo goes back to must not bring a clock that ran there back onto the screens.
 */
export function withoutClock<T>(s: T): T {
  if (!s || typeof s !== "object" || !("clock" in s)) return s;
  const copy = { ...(s as object) } as T & { clock?: unknown };
  delete copy.clock;
  return copy;
}

/**
 * The timer a screen shows: only a changeover, set break or break that is still
 * running at the score it started at (a point played since means it is over, even
 * when the console that played it never stopped it).
 */
export function liveClock(s: ScoreState | null | undefined, nowMs: number): (TimerView & { team: TeamKey | null; startedAt: string }) | null {
  const c = s?.clock;
  if (!s || !c || s.matchOver || !isTimerKind(c.kind) || c.kind === "between_points") return null;
  if (c.at !== scoreKey(s)) return null;
  const started = Date.parse(c.startedAt);
  if (!Number.isFinite(started)) return null;
  const elapsed = nowMs - started;
  // A timer nobody stopped is forgotten after half an hour.
  if (elapsed < -60_000 || elapsed > 30 * 60_000) return null;
  return { ...timerView(c.kind, elapsed), team: c.team ?? null, startedAt: c.startedAt };
}

export type TimeDecision = "code_violation" | "warning" | "no_action";
export const TIME_DECISIONS: readonly TimeDecision[] = ["code_violation", "warning", "no_action"];
export const TIME_DECISION_LABELS: Record<TimeDecision, string> = {
  code_violation: "Code violation",
  warning: "Warning",
  no_action: "No action",
};
