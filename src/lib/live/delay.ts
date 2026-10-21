/**
 * Audience delay ("delay meter"): fans see the score a set number of seconds
 * after the referee records it. Pure, shared with the app through @core.
 *
 * One setting per tournament, `branding_config.scoreDelay = { seconds }`, 0 (off,
 * the default) to MAX_SCORE_DELAY_SECONDS. With it on, every audience read (the
 * app's public routes, the public website, coaches, players' own views, alerts and
 * lock-screen scores) shows the tournament as it stood at `now − seconds`: the
 * cutoff. Officials (referee consoles, master referee desk, admin pages), the
 * venue TVs and the stream overlay stay real time.
 *
 * What "as it stood" means, row by row:
 *  - a match: its stored status, winner and times, turned back with matchAsOf
 *    (started after the cutoff → not started; finished after it → still live,
 *    no winner);
 *  - its score: the stored state of the last score event recorded at or before
 *    the cutoff (snapshotAsOf), mapped to the same row the server writes
 *    (snapshotRowFromState, used by ops.ts too). Events are append-only and an
 *    UNDO carries the state it goes back to, so "the last event at or before the
 *    cutoff" is exactly what the snapshot was then, superseded or not: an event
 *    marked superseded by a result entered after the cutoff was still the score
 *    at the cutoff;
 *  - a tie: its rubbers' as-of results through tieOutcome (tiesAsOf);
 *  - advancement: a team placed into a later match or tie by a result inside the
 *    window is hidden again (maskAdvancement, maskTieAdvancement).
 */
import type { CompletedSet, Match, MatchSnapshot, MatchStatus, Tie } from "../types";
import { tieOutcome } from "../tennis/ties";
import { currentServer, type ScoreState } from "../scoring/engine";

export const MAX_SCORE_DELAY_SECONDS = 120;
/** The meter's slider moves in these steps; the number field takes any whole second. */
export const SCORE_DELAY_STEP = 5;

export interface ScoreDelayConfig {
  seconds: number;
  /** When the organiser last saved it (audit only). */
  updatedAt?: string;
}

/** Whole seconds from 0 to MAX_SCORE_DELAY_SECONDS; anything else (text, NaN, negative) is 0, more than the maximum is the maximum. */
export function sanitizeScoreDelaySeconds(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_SCORE_DELAY_SECONDS, Math.round(n));
}

/** The stored setting, cleaned: `{ seconds }` (0 when missing or garbage). */
export function sanitizeScoreDelay(raw: unknown): ScoreDelayConfig {
  const seconds = raw && typeof raw === "object" ? sanitizeScoreDelaySeconds((raw as { seconds?: unknown }).seconds) : 0;
  const updatedAt = raw && typeof raw === "object" && typeof (raw as { updatedAt?: unknown }).updatedAt === "string" ? (raw as { updatedAt: string }).updatedAt : undefined;
  return updatedAt ? { seconds, updatedAt } : { seconds };
}

/**
 * The meter's typed value: whole seconds, 0 to the maximum, or why not. (The
 * stored value is read with sanitizeScoreDelay, which never refuses.)
 */
export function parseScoreDelayInput(raw: unknown): { ok: true; seconds: number } | { ok: false; message: string } {
  const text = String(raw ?? "").trim();
  const message = `Enter the delay as whole seconds from 0 to ${MAX_SCORE_DELAY_SECONDS}.`;
  if (!/^\d{1,3}$/.test(text)) return { ok: false, message };
  const n = Number(text);
  return n > MAX_SCORE_DELAY_SECONDS ? { ok: false, message } : { ok: true, seconds: n };
}

/** A tournament's audience delay in seconds, from its branding (0 = real time). */
export function scoreDelaySeconds(branding: { scoreDelay?: unknown } | null | undefined): number {
  return sanitizeScoreDelay(branding?.scoreDelay).seconds;
}

/** The moment the audience sees, in ms: `now − seconds`. */
export function cutoffFor(nowMs: number, seconds: number): number {
  return nowMs - Math.max(0, seconds) * 1000;
}

/** The admin meter's live preview line. */
export function scoreDelayPreview(seconds: number): string {
  const s = sanitizeScoreDelaySeconds(seconds);
  return s === 0 ? "Off: fans see every point as the referee records it." : `Fans see scores ${s} s after the referee records them.`;
}

/** The line fans read on the public site (and a future app) while the delay is on; null when off. */
export function scoreDelayNotice(seconds: number): string | null {
  const s = sanitizeScoreDelaySeconds(seconds);
  return s === 0 ? null : `Scores are shown ${s} s behind live.`;
}

/* ---------------- matches ---------------- */

export const FINISHED_STATUSES: readonly MatchStatus[] = ["completed", "walkover", "retired", "disqualified"];
const IN_PLAY: readonly MatchStatus[] = ["live", "paused", "pending_sync"];

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The match fields an audience view turns back. */
export type MatchTimes = Pick<Match, "status" | "winner_team_id" | "started_at" | "ended_at"> & {
  serving_team_id?: string | null;
  result_source?: Match["result_source"];
};

/**
 * A match as it stood at the cutoff. Started after it: not started yet (status
 * scheduled, no winner, no times, no server). Finished after it: still live, no
 * winner, no end time. A match whose times say nothing (older rows) is left as it is.
 */
export function matchAsOf<M extends MatchTimes>(m: M, cutoffMs: number): M {
  const started = ms(m.started_at);
  const ended = ms(m.ended_at);
  const finished = (FINISHED_STATUSES as readonly string[]).includes(m.status);
  const inPlay = (IN_PLAY as readonly string[]).includes(m.status);
  const notStarted = (finished || inPlay) && ((started !== null && started > cutoffMs) || (finished && started === null && ended !== null && ended > cutoffMs));
  if (notStarted) {
    return {
      ...m,
      status: "scheduled",
      winner_team_id: null,
      started_at: null,
      ended_at: null,
      ...("serving_team_id" in m ? { serving_team_id: null } : {}),
      ...("result_source" in m ? { result_source: null } : {}),
    };
  }
  if (finished && ended !== null && ended > cutoffMs) {
    return { ...m, status: "live", winner_team_id: null, ended_at: null, ...("result_source" in m ? { result_source: null } : {}) };
  }
  return m;
}

/** Whether the audience view of this match differs from the stored one (status or winner). */
export function matchChanged(real: MatchTimes, delayed: MatchTimes): boolean {
  return real.status !== delayed.status || real.winner_team_id !== delayed.winner_team_id;
}

/* ---------------- snapshots ---------------- */

/** The engine state's shape the snapshot row reads (scoring/engine.ts ScoreState is a superset). */
interface GamesStateLike {
  currentSet: number;
  teamA: { points: string; games: number; sets: number; tiebreakPoints: number };
  teamB: { points: string; games: number; sets: number; tiebreakPoints: number };
  isTiebreak: boolean;
  completedSets: CompletedSet[];
  servingTeam: "A" | "B" | null;
}

export interface SnapshotFacts {
  lastEventType?: string | null;
  lastEventTeamId?: string | null;
  /** The event number of the most recent UNDO applied, 0 if none. */
  lastUndoEventNumber?: number;
}

/**
 * The team serving the next point, as a team id. In a tie-break `servingTeam` is null (the
 * serve rotates every two points from the tie-break's first server), so the engine says who
 * serves now: every screen reading `serving_team_id` shows the ball in a tie-break too.
 */
export function servingTeamIdOf(match: Pick<Match, "team_a_id" | "team_b_id">, state: { servingTeam?: "A" | "B" | null; isTiebreak?: boolean } | null | undefined): string | null {
  const st = state as (ScoreState & { teamA?: unknown }) | null | undefined;
  const server = st?.isTiebreak && st.teamA ? currentServer(st) : (state?.servingTeam ?? null);
  return server === "A" ? match.team_a_id : server === "B" ? match.team_b_id : null;
}

/** A snapshot row as stored in match_score_snapshots (without its own id). */
export type SnapshotRow = Omit<MatchSnapshot, "id">;

/**
 * The match_score_snapshots row for an engine state: what upsertSnapshotFromState
 * (ops.ts) writes, and what an audience view rebuilds from an older event.
 * Non-games states (chess) keep the JSON and leave the set/game columns neutral.
 */
export function snapshotRowFromState(
  match: Pick<Match, "id" | "tournament_id" | "team_a_id" | "team_b_id">,
  state: unknown,
  lastEventNumber: number,
  facts: SnapshotFacts = {},
  updatedAt: string = new Date().toISOString(),
): SnapshotRow {
  const eventFacts = {
    last_event_type: facts.lastEventType ?? null,
    last_event_team_id: facts.lastEventTeamId ?? null,
    last_undo_event_number: facts.lastUndoEventNumber ?? 0,
  };
  const loose = (state ?? {}) as { teamA?: unknown; fen?: string; games?: unknown };
  if (loose.teamA === undefined || loose.games !== undefined || loose.fen !== undefined) {
    return {
      match_id: match.id,
      tournament_id: match.tournament_id,
      current_set_number: 1,
      team_a_point_label: "",
      team_b_point_label: "",
      team_a_games: 0,
      team_b_games: 0,
      team_a_sets: 0,
      team_b_sets: 0,
      is_tiebreak: false,
      tiebreak_team_a_points: 0,
      tiebreak_team_b_points: 0,
      serving_team_id: null,
      last_event_number: lastEventNumber,
      ...eventFacts,
      completed_sets: [],
      snapshot_json: state,
      updated_at: updatedAt,
    };
  }
  const s = state as GamesStateLike;
  return {
    match_id: match.id,
    tournament_id: match.tournament_id,
    current_set_number: s.currentSet,
    team_a_point_label: s.teamA.points,
    team_b_point_label: s.teamB.points,
    team_a_games: s.teamA.games,
    team_b_games: s.teamB.games,
    team_a_sets: s.teamA.sets,
    team_b_sets: s.teamB.sets,
    is_tiebreak: s.isTiebreak,
    tiebreak_team_a_points: s.teamA.tiebreakPoints,
    tiebreak_team_b_points: s.teamB.tiebreakPoints,
    serving_team_id: servingTeamIdOf(match, s),
    last_event_number: lastEventNumber,
    ...eventFacts,
    completed_sets: s.completedSets,
    snapshot_json: state,
    updated_at: updatedAt,
  };
}

/** A stored score event, as much of it as an as-of rebuild reads. */
export interface AsOfEvent {
  match_id: string;
  event_number: number;
  event_type: string;
  team_id: string | null;
  new_state_json: unknown;
  created_at_server: string | null;
}

/** Whether a stored snapshot changed after the cutoff (only those need their events read). */
export function snapshotNeedsRebuild(s: Pick<MatchSnapshot, "updated_at"> | null | undefined, cutoffMs: number): boolean {
  const t = ms(s?.updated_at ?? null);
  return t === null || t > cutoffMs;
}

/**
 * The first event number recorded after the cutoff, per match (the events of the
 * window). A match missing from the map had nothing recorded after the cutoff.
 */
export function firstInWindow(events: { match_id: string; event_number: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const n = out.get(e.match_id);
    if (n === undefined || e.event_number < n) out.set(e.match_id, e.event_number);
  }
  return out;
}

/** The latest UNDO before `before`, from a list of (match, event number) UNDO rows; 0 if none. */
export function lastUndoBefore(undos: { match_id: string; event_number: number }[], matchId: string, before: number): number {
  let best = 0;
  for (const u of undos) if (u.match_id === matchId && u.event_number < before && u.event_number > best) best = u.event_number;
  return best;
}

/**
 * A match's snapshot as it stood at the cutoff.
 *  - nothing recorded after the cutoff (`first` undefined): the stored snapshot;
 *  - the window starts at event 1, or the event before it is missing: no score yet (null);
 *  - otherwise the row rebuilt from the last event at or before the cutoff (`asOf`,
 *    number `first − 1`), with the UNDO watermark as it stood then (`undo`).
 */
export function snapshotAsOf(
  match: Pick<Match, "id" | "tournament_id" | "team_a_id" | "team_b_id">,
  current: MatchSnapshot | null,
  first: number | undefined,
  asOf: AsOfEvent | null,
  undo: number,
): MatchSnapshot | null {
  if (first === undefined) return current;
  if (!asOf || asOf.event_number !== first - 1 || !asOf.new_state_json) return null;
  const row = snapshotRowFromState(
    match,
    asOf.new_state_json,
    asOf.event_number,
    { lastEventType: asOf.event_type, lastEventTeamId: asOf.team_id, lastUndoEventNumber: undo },
    asOf.created_at_server ?? current?.updated_at ?? new Date(0).toISOString(),
  );
  return { ...(current?.id ? { id: current.id } : {}), ...row } as MatchSnapshot;
}

/* ---------------- ties ---------------- */

type TieLike = Pick<Tie, "id" | "team_a_id" | "team_b_id" | "status" | "rubbers_a" | "rubbers_b" | "winner_team_id" | "ended_at"> & {
  stage?: Tie["stage"];
  winner_to_tie_id?: string | null;
  winner_to_side?: "A" | "B" | null;
  loser_to_tie_id?: string | null;
  loser_to_side?: "A" | "B" | null;
};
type RubberLike = Pick<Match, "id" | "status" | "winner_team_id"> & { tie_id?: string | null; team_a_id: string | null; team_b_id: string | null };

/**
 * Ties as they stood at the cutoff, from their rubbers' as-of results. A tie none
 * of whose rubbers changed is left as it is. A rubber cancelled because the tie
 * was decided inside the window (a dead rubber an event does not play) is shown
 * as still to play again. Returns the ties and the rubbers with those restored.
 */
export function tiesAsOf<T extends TieLike, R extends RubberLike>(
  ties: T[],
  real: R[],
  delayed: R[],
  playDead: (tie: T) => boolean,
): { ties: T[]; rubbers: R[] } {
  const realById = new Map(real.map((r) => [r.id, r]));
  const restore = new Set<string>();
  const out = ties.map((t) => {
    const rubbers = delayed.filter((r) => r.tie_id === t.id);
    const changed = rubbers.some((r) => {
      const was = realById.get(r.id);
      return !was || was.status !== r.status || was.winner_team_id !== r.winner_team_id;
    });
    if (!changed) return t;
    const outcome = tieOutcome(
      rubbers.map((r) => ({ id: r.id, status: r.status, winner: r.winner_team_id ? (r.winner_team_id === t.team_a_id ? "A" : "B") : null })),
      playDead(t),
    );
    const winner = outcome.winner === "A" ? t.team_a_id : outcome.winner === "B" ? t.team_b_id : null;
    // Only rubbers this result cancelled come back (never one the organiser called off).
    if (t.winner_team_id && !winner) for (const id of outcome.restore) restore.add(id);
    const status = t.status === "scheduled" ? "scheduled" : outcome.status;
    return {
      ...t,
      rubbers_a: outcome.rubbersA,
      rubbers_b: outcome.rubbersB,
      winner_team_id: winner,
      status,
      ended_at: status === "completed" ? t.ended_at : null,
    };
  });
  const rubbers = restore.size ? delayed.map((r) => (restore.has(r.id) ? { ...r, status: "scheduled" as MatchStatus } : r)) : delayed;
  return { ties: out, rubbers };
}

/**
 * Who a tie decided inside the window sent on: the winner (and loser) placed into
 * the next tie by that result are hidden again (TBD) while that tie has not
 * started, and so are the next tie's rubbers' sides. Returns the ties and rubbers.
 */
export function maskTieAdvancement<T extends TieLike, R extends RubberLike & { team_a_player_ids?: string[] | null; team_b_player_ids?: string[] | null }>(
  realTies: T[],
  delayedTies: T[],
  rubbers: R[],
): { ties: T[]; rubbers: R[] } {
  const delayedById = new Map(delayedTies.map((t) => [t.id, t]));
  const hide = new Map<string, { side: "A" | "B"; team: string }[]>();
  for (const t of realTies) {
    const d = delayedById.get(t.id);
    if (!t.winner_team_id || !d || d.winner_team_id) continue;
    const loser = t.winner_team_id === t.team_a_id ? t.team_b_id : t.team_a_id;
    const add = (tieId: string | null | undefined, side: "A" | "B" | null | undefined, team: string | null) => {
      if (!tieId || !side || !team) return;
      hide.set(tieId, [...(hide.get(tieId) ?? []), { side, team }]);
    };
    add(t.winner_to_tie_id, t.winner_to_side, t.winner_team_id);
    add(t.loser_to_tie_id, t.loser_to_side, loser);
  }
  if (!hide.size) return { ties: delayedTies, rubbers };
  const masked = new Map<string, Set<string>>();
  const ties = delayedTies.map((t) => {
    const h = hide.get(t.id);
    if (!h || t.status !== "scheduled") return t;
    let next = t;
    for (const { side, team } of h) {
      const key = side === "A" ? "team_a_id" : "team_b_id";
      if (next[key] === team) {
        next = { ...next, [key]: null };
        masked.set(t.id, new Set([...(masked.get(t.id) ?? []), team]));
      }
    }
    return next;
  });
  const out = rubbers.map((r) => {
    const teams = r.tie_id ? masked.get(r.tie_id) : undefined;
    if (!teams) return r;
    let next = r;
    if (next.team_a_id && teams.has(next.team_a_id)) next = { ...next, team_a_id: null, ...("team_a_player_ids" in next ? { team_a_player_ids: [] } : {}) };
    if (next.team_b_id && teams.has(next.team_b_id)) next = { ...next, team_b_id: null, ...("team_b_player_ids" in next ? { team_b_player_ids: [] } : {}) };
    return next;
  });
  return { ties, rubbers: out };
}

/* ---------------- knockout advancement ---------------- */

type AdvanceLike = Pick<Match, "id" | "status" | "winner_team_id" | "team_a_id" | "team_b_id"> & { stage?: string; tie_id?: string | null };

/**
 * A knockout result inside the window put its winner (and a semi-final's loser)
 * into a later match: hide them there again (TBD) while that match has not
 * started. A team of a match the audience still sees in play cannot be in a later
 * knockout match yet. Ties advance through maskTieAdvancement instead.
 * `hidden` lists, per match, the teams taken out (for the bracket's slots).
 */
export function maskAdvancement<M extends AdvanceLike>(real: M[], delayed: M[]): { matches: M[]; hidden: Map<string, Set<string>> } {
  const delayedById = new Map(delayed.map((m) => [m.id, m]));
  const pending = new Set<string>();
  const sources = new Map<string, string>();
  for (const m of real) {
    const d = delayedById.get(m.id);
    if (m.tie_id || !d || !(FINISHED_STATUSES as readonly string[]).includes(m.status) || (FINISHED_STATUSES as readonly string[]).includes(d.status)) continue;
    for (const t of [m.team_a_id, m.team_b_id]) if (t) {
      pending.add(t);
      sources.set(t, m.id);
    }
  }
  const hidden = new Map<string, Set<string>>();
  if (!pending.size) return { matches: delayed, hidden };
  const matches = delayed.map((m) => {
    // Group and session rotations draw every match up front: a team in one of those is no advancement.
    if (m.tie_id || m.stage === "group" || m.stage === "friendly" || !["scheduled", "ready"].includes(m.status)) return m;
    let next = m;
    for (const key of ["team_a_id", "team_b_id"] as const) {
      const team = next[key];
      if (team && pending.has(team) && sources.get(team) !== m.id) {
        next = { ...next, [key]: null };
        hidden.set(m.id, new Set([...(hidden.get(m.id) ?? []), team]));
      }
    }
    return next;
  });
  return { matches, hidden };
}

/** Bracket slots with the teams maskAdvancement hid taken out again. */
export function maskBracketSlots<S extends { match_id: string | null; team_id: string | null }>(slots: S[], hidden: Map<string, Set<string>>): S[] {
  if (!hidden.size) return slots;
  return slots.map((s) => (s.match_id && s.team_id && hidden.get(s.match_id)?.has(s.team_id) ? { ...s, team_id: null } : s));
}

/* ---------------- alerts ---------------- */

/**
 * Alerts that tell fans, players and coaches how play is going: sent `seconds`
 * later when the delay is on. Calls to court, match soon, line-ups, schedules
 * and announcements are for getting people to the court: never delayed.
 */
export const SCORE_ALERT_KINDS: ReadonlySet<string> = new Set([
  "match_live",
  "match_finished",
  "tie_decided",
  "coach_started",
  "coach_finished",
  "coach_tie_result",
]);

/** The outbox kind of a lock-screen score update held back by the delay (sent by the drain, never as an alert). */
export const DEFERRED_LIVE_ACTIVITY = "live_activity_deferred";

/** Deferred lock-screen pushes of one match within this many ms share one outbox row (the drain sends the latest view). */
export const LIVE_ACTIVITY_BUCKET_MS = 5_000;
