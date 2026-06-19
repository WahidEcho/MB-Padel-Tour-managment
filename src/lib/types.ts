export type Role = "admin" | "manager" | "referee" | "operator";

export type Sport = "padel" | "chess";

export type CheckInStatus = "not_arrived" | "checked_in" | "no_show" | "disqualified";

export type MatchStatus =
  | "scheduled"
  | "ready"
  | "live"
  | "paused"
  | "completed"
  | "walkover"
  | "disqualified"
  | "retired"
  | "cancelled"
  | "pending_sync";

export type Stage = "group" | "quarter_final" | "semi_final" | "final" | "third_place" | "knockout";

export interface ScoringConfig {
  setsToWinMatch: number;
  gamesToWinSet: number;
  tiebreakEnabled: boolean;
  tiebreakAtGames: number;
  tiebreakTargetPoints: number;
  tiebreakWinByTwo: boolean;
  walkoverScore: string;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  setsToWinMatch: 1,
  gamesToWinSet: 6,
  tiebreakEnabled: true,
  tiebreakAtGames: 6,
  tiebreakTargetPoints: 7,
  tiebreakWinByTwo: true,
  walkoverScore: "6-0",
};

export interface FormatConfig {
  // "group_knockout" (padel default) or "knockout" (chess: no group stage).
  type: "group_knockout" | "knockout";
  qualifyPerGroup?: number;
  thirdPlaceMatch?: boolean;
  // Chess knockout only: games per pairing (1 or 2). Defaults to 1.
  legs?: 1 | 2;
}

export const DEFAULT_CHESS_FORMAT: FormatConfig = {
  type: "knockout",
  legs: 1,
  thirdPlaceMatch: false,
};

export interface BrandingConfig {
  moveBeyondLogoUrl?: string;
  clientLogoUrl?: string;
  eventLogoUrl?: string;
  sponsorLogoUrls?: string[];
  backgroundUrl?: string;
}

export interface Tournament {
  id: string;
  name: string;
  slug: string;
  sport: string;
  status: "draft" | "active" | "completed" | "archived";
  is_demo: boolean;
  cloned_from_tournament_id: string | null;
  branding_config: BrandingConfig;
  scoring_config: ScoringConfig;
  format_config: FormatConfig;
  court_config: Record<string, unknown>;
  lower_third_text: string;
  public_access_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface Team {
  id: string;
  tournament_id: string;
  team_name: string;
  phone: string | null;
  notes: string | null;
  seed_number: number | null;
  check_in_status: CheckInStatus;
  team_status: "active" | "disqualified" | "withdrawn";
  players?: Player[];
}

export interface Player {
  id: string;
  tournament_id: string;
  team_id: string;
  player_order: number;
  full_name: string;
  photo_url: string | null;
}

export interface Court {
  id: string;
  tournament_id: string;
  court_name: string;
  court_order: number;
  is_active: boolean;
}

export interface Group {
  id: string;
  tournament_id: string;
  group_name: string;
  group_order: number;
  status: "draft" | "published";
}

export interface GroupTeam {
  id: string;
  tournament_id: string;
  group_id: string;
  team_id: string;
  position: number;
  is_locked: boolean;
}

export interface Match {
  id: string;
  tournament_id: string;
  stage: Stage;
  group_id: string | null;
  round_name: string | null;
  match_order: number;
  court_id: string | null;
  scheduled_time: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  status: MatchStatus;
  serving_team_id: string | null;
  winner_team_id: string | null;
  active_scoring_device_id: string | null;
  is_pending_sync: boolean;
  started_at: string | null;
  ended_at: string | null;
}

export interface CompletedSet {
  teamAGames: number;
  teamBGames: number;
  tiebreak?: { a: number; b: number };
}

export interface MatchSnapshot {
  id: string;
  match_id: string;
  tournament_id: string;
  current_set_number: number;
  team_a_point_label: string;
  team_b_point_label: string;
  team_a_games: number;
  team_b_games: number;
  team_a_sets: number;
  team_b_sets: number;
  is_tiebreak: boolean;
  tiebreak_team_a_points: number;
  tiebreak_team_b_points: number;
  serving_team_id: string | null;
  last_event_number: number;
  completed_sets: CompletedSet[];
  snapshot_json: unknown;
  updated_at: string;
}

export interface Standing {
  id?: string;
  tournament_id: string;
  group_id: string;
  team_id: string;
  rank: number;
  played: number;
  won: number;
  lost: number;
  points: number;
  sets_won: number;
  sets_lost: number;
  set_diff: number;
  games_won: number;
  games_lost: number;
  game_diff: number;
  status: "pending" | "qualified" | "eliminated" | "disqualified";
  manual_status_override: boolean;
}

export interface Bracket {
  id: string;
  tournament_id: string;
  bracket_name: string;
  status: "draft" | "approved" | "published";
  approved_by: string | null;
  approved_at: string | null;
  published_at: string | null;
}

export interface BracketSlot {
  id: string;
  bracket_id: string;
  tournament_id: string;
  round_name: string;
  slot_order: number;
  match_id: string | null;
  team_id: string | null;
  source_type: string | null;
  source_ref: string | null;
  is_bye: boolean;
}

export interface ScreenSettings {
  id: string;
  tournament_id: string;
  screen_key: string;
  display_mode: "leaderboard" | "live_court" | "all_live" | "bracket" | "winner" | "sponsors";
  focus_court_id: string | null;
  theme: "dark" | "light";
  sponsor_rotation_seconds: number;
}
