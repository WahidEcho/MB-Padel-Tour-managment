/**
 * The shape the venue screen polls for, and the rule for when a poll should
 * trigger a full re-render.
 *
 * Pure and framework-free, so the route that builds it and the hook that reads it
 * agree by construction.
 */
import type { Match, MatchSnapshot, ScreenSettings } from "../types";
import type { ScoreState } from "../scoring/engine";
import type { ScoreFrame } from "./pointBeat";

export interface LiveMatch {
  id: string;
  status: Match["status"];
  stage: Match["stage"];
  court_id: string | null;
  bracket_id: string | null;
  round_name: string | null;
  match_order: number;
  scheduled_time: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  winner_team_id: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface LiveSnapshot {
  match_id: string;
  last_event_number: number;
  last_undo_event_number: number;
  points: [string, string];
  games: [number, number];
  sets: [number, number];
  tiebreak: boolean;
  /** Tennis: the tie-break is a match tie-break played in place of the final set. */
  match_tiebreak?: boolean;
  tiebreak_points: [number, number];
  serving_team_id: string | null;
  completed_sets: MatchSnapshot["completed_sets"];
  match_over: boolean;
  /**
   * The full score state while the match is unfinished: tennis walls read the
   * serving player, the callouts and the rules-aware bits from it. Left out once
   * a match is over, so the feed does not grow with the day's results.
   */
  state?: ScoreState;
}

export type LiveScreen = Pick<
  ScreenSettings,
  | "revision"
  | "display_mode"
  | "court_ids"
  | "focus_court_id"
  | "focus_match_id"
  | "bracket_tier"
  | "mute_animations"
  | "break_started_at"
  | "break_ends_at"
  | "ceremony_step"
  | "ceremony_step_at"
  | "entrance_replay"
  | "theme"
>;

export interface LiveFeed {
  /** Server epoch ms when this was produced. Anchors every timeline on the wall. */
  fetchedAt: number;
  /**
   * When the tournament row last changed. A new background, logo or sponsor is
   * part of the server render, so a change here re-renders the wall.
   */
  brandingStamp?: string | null;
  screen: LiveScreen;
  matches: LiveMatch[];
  snapshots: LiveSnapshot[];
}

export function toLiveMatch(m: Match): LiveMatch {
  return {
    id: m.id,
    status: m.status,
    stage: m.stage,
    court_id: m.court_id,
    bracket_id: m.bracket_id,
    round_name: m.round_name,
    match_order: m.match_order,
    scheduled_time: m.scheduled_time,
    team_a_id: m.team_a_id,
    team_b_id: m.team_b_id,
    winner_team_id: m.winner_team_id,
    started_at: m.started_at,
    ended_at: m.ended_at,
  };
}

export function toLiveSnapshot(s: MatchSnapshot): LiveSnapshot {
  const json = (s.snapshot_json ?? {}) as { matchOver?: boolean; isMatchTiebreak?: boolean; teamA?: unknown };
  return {
    match_id: s.match_id,
    last_event_number: s.last_event_number,
    last_undo_event_number: s.last_undo_event_number ?? 0,
    points: [s.team_a_point_label, s.team_b_point_label],
    games: [s.team_a_games, s.team_b_games],
    sets: [s.team_a_sets, s.team_b_sets],
    tiebreak: s.is_tiebreak,
    match_tiebreak: s.is_tiebreak && Boolean(json.isMatchTiebreak),
    tiebreak_points: [s.tiebreak_team_a_points, s.tiebreak_team_b_points],
    serving_team_id: s.serving_team_id,
    completed_sets: s.completed_sets ?? [],
    match_over: Boolean(json.matchOver),
    ...(json.teamA && !json.matchOver ? { state: s.snapshot_json as unknown as ScoreState } : {}),
  };
}

/** The classifier's view of a snapshot. */
export function frameFrom(s: LiveSnapshot): ScoreFrame {
  return {
    eventNumber: s.last_event_number,
    undoWatermark: s.last_undo_event_number,
    sets: s.sets,
    games: s.games,
    tiebreak: s.tiebreak,
    tiebreakPoints: s.tiebreak_points,
    points: s.points,
    matchOver: s.match_over,
  };
}

/**
 * Whether a new poll changes more than scores, so the server-rendered parts —
 * team names, standings, the bracket tree — need rendering again.
 *
 * Deliberately narrow. A score changing is handled entirely on the client, so a
 * point never costs a server render. A new match appearing, an operator changing
 * the screen, or a match changing state does.
 */
export function needsStructuralRefresh(prev: LiveFeed | null, next: LiveFeed): boolean {
  if (!prev) return false;
  if (prev.screen.revision !== next.screen.revision) return true;
  if ((prev.brandingStamp ?? null) !== (next.brandingStamp ?? null)) return true;
  if (prev.matches.length !== next.matches.length) return true;
  const before = new Map(prev.matches.map((m) => [m.id, m]));
  for (const m of next.matches) {
    const was = before.get(m.id);
    if (!was) return true;
    if (was.status !== m.status || was.team_a_id !== m.team_a_id || was.team_b_id !== m.team_b_id) return true;
    if (was.court_id !== m.court_id) return true;
  }
  return false;
}
