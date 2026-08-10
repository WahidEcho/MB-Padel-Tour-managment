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

export type Stage =
  | "group"
  | "quarter_final"
  | "semi_final"
  | "final"
  | "third_place"
  | "knockout"
  // Friendly-session matches. They are ordinary `matches` rows so they reuse the
  // whole scoring stack; `finalizeMatch` branches on this to award player points
  // instead of recalculating group standings or advancing a bracket.
  | "friendly";

/**
 * Distinguishes real tournaments from the hidden backing rows that friendly
 * sessions own. Tournament lists must filter on `kind = "tournament"`.
 */
export type TournamentKind = "tournament" | "friendly_session";

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
  kind: TournamentKind;
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
  /** Link to a persistent profile. Null for tournament players not yet matched. */
  player_profile_id?: string | null;
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

/* ------------------------------------------------------------------ */
/* Friendly sessions (see DECISIONS.md for the locked rules)           */
/* ------------------------------------------------------------------ */

export type PairingMode = "fixed" | "americano" | "mexicano";

export type FriendlySessionStatus =
  | "draft"
  | "open"
  | "scheduled"
  | "live"
  | "completed"
  | "finalized";

export type EntryApproval = "pending" | "approved" | "waitlisted" | "rejected" | "withdrawn";

export type LedgerComponent = "base_win" | "fire" | "games";
export type LedgerSource = "friendly" | "tournament";
export type LedgerStatus = "provisional" | "official";

/**
 * How a finished match converts into ranking points. Matches themselves always
 * use the padel scoring engine (sets/games) — only the conversion differs.
 *  - "win_points": 3 per win + fire streak (the house rule; default).
 *  - "games_won":  each player banks the games their side won, so a 6-4 set
 *                  gives the winners 6 each and the losers 4 each. This is the
 *                  Americano philosophy adapted to set scoring and is what
 *                  makes the Mexicano court ladder meaningful.
 * Fire streaks apply in both models.
 */
export type RankingModel = "win_points" | "games_won";

/**
 * Mexicano within-court pairing. Three incompatible conventions ship in the
 * wild; ranks are 1-4 best-to-worst within a court.
 *  - "balanced_1_4":  1+4 v 2+3 — equal rank sums (default, most common).
 *  - "semi_1_3":      1+3 v 2+4 — slight edge to the top pair.
 *  - "top_heavy_1_2": 1+2 v 3+4 — strongest pair together, deliberately uneven.
 */
export type MexicanoPairing = "balanced_1_4" | "semi_1_3" | "top_heavy_1_2";

/** Messaging channels we may hold consent for. SMS is deliberately absent. */
export type ConsentChannel = "whatsapp" | "web_push" | "email";

export interface PlayerConsent {
  id: string;
  player_profile_id: string;
  channel: ConsentChannel;
  granted: boolean;
  granted_at: string | null;
  revoked_at: string | null;
  source: "registration" | "admin" | "player";
}

export interface PlayerProfile {
  id: string;
  public_name: string;
  /** Canonical form. Server-side and admin-only — never sent to public pages. */
  mobile_normalized: string | null;
  approval_status: "pending" | "approved" | "rejected" | "merged";
  /** Cache of the live fire streak; always rebuildable from the ledger. */
  active_streak: number;
  streak_last_ledger_id: number | null;
  merged_into_profile_id: string | null;
  /** Reserved for a future player login. Nothing reads these today. */
  auth_user_id: string | null;
  claim_status: "unclaimed" | "claimed";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Public projection of a profile — safe to send to unauthenticated pages. */
export interface PublicPlayer {
  id: string;
  public_name: string;
}

export interface Season {
  id: string;
  name: string;
  starts_on: string | null;
  ends_on: string | null;
  status: "upcoming" | "active" | "closed";
}

export interface RankingCategory {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
}

export interface FriendlySession {
  id: string;
  /** The hidden backing tournament row carrying courts + scoring_config. */
  tournament_id: string;
  season_id: string | null;
  slug: string;
  name: string;
  status: FriendlySessionStatus;
  starts_at: string | null;
  duration_minutes: number;
  registration_deadline: string | null;
  expected_match_minutes: number;
  turnover_minutes: number;
  pairing_mode: PairingMode;
  ranking_model: RankingModel;
  mexicano_pairing: MexicanoPairing;
  /** Seed for the round-1 random draw, stored so regeneration is reproducible. */
  draw_seed: number | null;
  cutoff_policy: "no_new_matches" | "open";
  cutoff_extended_minutes: number;
  max_players: number | null;
  visibility: "public" | "unlisted";
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FriendlyEntry {
  id: string;
  session_id: string;
  player_profile_id: string;
  source: "self" | "admin";
  approval: EntryApproval;
  preferred_partner_profile_id: string | null;
  checked_in: boolean;
  registered_at: string;
}

export interface FriendlyPair {
  id: string;
  session_id: string;
  /** The backing `teams` row this pair plays as. */
  team_id: string;
  player_one_profile_id: string;
  player_two_profile_id: string | null;
  label: string | null;
  active_from_round: number;
  retired_after_round: number | null;
}

/** Immutable record of who actually played a match. */
export interface FriendlyMatchParticipants {
  match_id: string;
  session_id: string;
  pair_a_id: string | null;
  pair_b_id: string | null;
  team_a_player_one: string;
  team_a_player_two: string | null;
  team_b_player_one: string;
  team_b_player_two: string | null;
  round_number: number | null;
}

export interface LedgerRow {
  /** Server-assigned identity — the authoritative order for fire replay. */
  id: number;
  player_profile_id: string;
  match_id: string;
  source: LedgerSource;
  session_id: string | null;
  tournament_id: string | null;
  season_id: string | null;
  component: LedgerComponent;
  points: number;
  status: LedgerStatus;
  created_at: string;
}

export interface FriendlyRankingSnapshot {
  id?: string;
  scope: "session" | "season" | "lifetime";
  scope_id: string | null;
  player_profile_id: string;
  rank: number;
  points: number;
  base_points: number;
  fire_points: number;
  wins: number;
  losses: number;
  games_won: number;
  games_lost: number;
  game_diff: number;
  matches_played: number;
  active_streak: number;
  calculated_at?: string;
}

/** Which competition a match belongs to. */
export type CompetitionContext =
  | { kind: "tournament"; tournamentId: string }
  | { kind: "friendly"; sessionId: string; tournamentId: string };

export interface FriendlyConfigDefaults {
  durationMinutes: number;
  turnoverMinutes: number;
  matchMinutesOneSet: number;
  matchMinutesBestOfThree: number;
}

export const DEFAULT_FRIENDLY_CONFIG: FriendlyConfigDefaults = {
  durationMinutes: 120,
  turnoverMinutes: 5,
  matchMinutesOneSet: 30,
  matchMinutesBestOfThree: 60,
};
