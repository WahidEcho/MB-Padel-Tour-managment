export type Role = "admin" | "manager" | "referee" | "operator";

export type Sport = "padel" | "chess" | "tennis";

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

/**
 * The rules a single match is played under. Every engine mutator takes these as
 * its last argument, so a match can be scored under different rules from the
 * tournament default without any change to the engine.
 */
export interface MatchRules {
  setsToWinMatch: number;
  gamesToWinSet: number;
  tiebreakEnabled: boolean;
  tiebreakAtGames: number;
  tiebreakTargetPoints: number;
  tiebreakWinByTwo: boolean;
  walkoverScore: string;
  /**
   * No-ad scoring: at 40-40 the next point wins the game (the receivers choose
   * which of them receives it). Absent means advantage scoring, as before.
   */
  decidingPoint?: boolean;
  /**
   * When the sets are level one short of the match, the deciding set is played
   * as a single match tie-break instead (tennis doubles: at one set all).
   */
  matchTiebreak?: boolean;
  /** Points to win that match tie-break, win by two. Defaults to 10. */
  matchTiebreakPoints?: number;
}

/**
 * Which bucket of the tournament a match belongs to, for rule purposes.
 *
 * The quarter-finals, semi-finals and third-place match share one bucket: the
 * third-place match is played just before the final and is shortened with the
 * semis, not with it. `knockout` covers the rounds of 16 and earlier.
 *
 * The `plate_*` keys exist because the Plate bracket may be played under
 * different rules from the Cup — a one-set Plate final alongside a best-of-three
 * Cup final. A blank `plate_*` override inherits the Cup's.
 */
export type StageRuleKey =
  | "group"
  | "quarter_semi"
  | "final"
  | "bracket"
  | "plate_quarter_semi"
  | "plate_final"
  | "plate_bracket";

export interface ScoringConfig extends MatchRules {
  /**
   * Per-stage rule overrides. Absent keys inherit the tournament default, so an
   * existing tournament with no overrides behaves exactly as it did before.
   * Friendly-session matches never take an override.
   */
  stageOverrides?: Partial<Record<StageRuleKey, Partial<MatchRules>>>;
  /**
   * When true, the match-winning point no longer finalizes the match on its own:
   * the referee sees the final score and must press Confirm result. Explicit end
   * events (walkover, retirement, disqualification, force-end) always finalize.
   */
  requireResultConfirmation?: boolean;
  /**
   * Tennis: rules a doubles match takes on top of the resolved stage rules
   * (normally the deciding point and a match tie-break in place of a final set).
   * Ignored for padel, where every match is a doubles match under the base rules.
   */
  doubles?: Partial<MatchRules>;
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

/**
 * Standard tennis rules: best of three tie-break sets with advantage scoring.
 * Doubles uses no-ad scoring and a 10-point match tie-break at one set all.
 */
export const DEFAULT_TENNIS_SCORING_CONFIG: ScoringConfig = {
  setsToWinMatch: 2,
  gamesToWinSet: 6,
  tiebreakEnabled: true,
  tiebreakAtGames: 6,
  tiebreakTargetPoints: 7,
  tiebreakWinByTwo: true,
  walkoverScore: "6-0",
  doubles: { decidingPoint: true, matchTiebreak: true, matchTiebreakPoints: 10 },
};

export interface FormatConfig {
  // "group_knockout" (padel default) or "knockout" (chess: no group stage).
  type: "group_knockout" | "knockout";
  qualifyPerGroup?: number;
  thirdPlaceMatch?: boolean;
  // Chess knockout only: games per pairing (1 or 2). Defaults to 1.
  legs?: 1 | 2;
  /** Tennis team competition: present means every fixture is a tie of rubbers. */
  ties?: TieFormatConfig;
  /**
   * Per-bracket settings. `cup` is the main bracket (1st and 2nd per group);
   * `plate` is the second bracket for the teams below them, off unless enabled.
   * `cup.thirdPlaceMatch` falls back to the legacy `thirdPlaceMatch` above.
   */
  tiers?: {
    cup?: { thirdPlaceMatch?: boolean; podiumDepth?: 1 | 2 | 3 | 4 };
    plate?: {
      enabled: boolean;
      perGroup?: number;
      thirdPlaceMatch?: boolean;
      podiumDepth?: 1 | 2 | 3 | 4;
    };
  };
}

/** The three rubbers of a tie, in the default order of play. See src/lib/tennis/ties.ts. */
export type RubberType = "S2" | "S1" | "D";

/**
 * A nation-v-nation team competition: every group match and placement match is
 * a tie of rubbers rather than a single match.
 */
export interface TieFormatConfig {
  /** Order of play within a tie. Defaults to No. 2 singles, No. 1 singles, doubles. */
  rubbers?: RubberType[];
  /**
   * Once a tie is decided, are its remaining rubbers played? Group ties play them
   * (they count in the group ranking); placement ties drop them by default.
   */
  playDeadRubbersInPlacement?: boolean;
  /**
   * Demo events: a known result per rubber, by match id, from team A's side
   * ("6-2 6-1", "5-7 4-6"), which the replay console plays point by point.
   */
  replays?: Record<string, string>;
}

export interface Tie {
  id: string;
  tournament_id: string;
  stage: "group" | "placement";
  group_id: string | null;
  draw_from: number | null;
  draw_to: number | null;
  places_from: number | null;
  places_to: number | null;
  round_no: number;
  round_name: string | null;
  tie_order: number;
  court_id: string | null;
  scheduled_time: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  status: "scheduled" | "live" | "completed";
  rubbers_a: number;
  rubbers_b: number;
  winner_team_id: string | null;
  winner_to_tie_id: string | null;
  winner_to_side: "A" | "B" | null;
  loser_to_tie_id: string | null;
  loser_to_side: "A" | "B" | null;
  lineup_locked_at: string | null;
  ended_at: string | null;
}

export const DEFAULT_CHESS_FORMAT: FormatConfig = {
  type: "knockout",
  legs: 1,
  thirdPlaceMatch: false,
};

export type SponsorIntensity = "subtle" | "standard" | "vivid";

/** The one sponsor that glows behind the venue screen and the public dashboard. */
export interface MainSponsor {
  name: string;
  logoUrl: string;
  /** `#rrggbb`. Drives the bloom, the ring and the mark's glow. */
  accentHex: string;
  intensity?: SponsorIntensity;
  /** Defaults to on: the dashboard is part of the sponsor's exposure. */
  showOnDashboard?: boolean;
  /** Width over height of the logo, measured on upload. */
  aspect?: number;
}

/** Every other sponsor, in the order they loop along the footer. */
export interface SponsorEntry {
  name: string;
  logoUrl: string;
  tier?: string;
  /** Width over height, measured on upload so the footer can be laid out before a logo loads. */
  aspect?: number;
}

/** What the holding slate says between sessions of play. */
export interface HoldingContent {
  title?: string;
  message?: string;
  imageUrl?: string;
}

/** How strongly the event background is darkened (or lightened, on a light page) under the content. */
export type BackgroundDim = "none" | "light" | "medium" | "strong";

/**
 * A moving (or still) picture behind the event's screens: a GIF, an animated SVG,
 * an animated WebP or PNG, a still photo, or a short muted video loop.
 */
export interface EventBackground {
  url: string;
  kind: "image" | "svg" | "video";
  mime: string;
  bytes: number;
  dim: BackgroundDim;
  /** Also behind the public dashboard pages. Off by default: a video costs phones data. */
  showOnPublic: boolean;
}

export interface BrandingConfig {
  moveBeyondLogoUrl?: string;
  clientLogoUrl?: string;
  eventLogoUrl?: string;
  /** Legacy: bare URLs. Read through resolveSponsors, which also accepts `sponsors`. */
  sponsorLogoUrls?: string[];
  backgroundUrl?: string;
  mainSponsor?: MainSponsor;
  sponsors?: SponsorEntry[];
  holding?: HoldingContent;
  background?: EventBackground;
  /**
   * Red and blue teams: every match's first-listed team is Red, the second Blue,
   * in the voice umpire's calls and on the screens. See src/lib/sides.ts.
   */
  redBlueTeams?: boolean;
  /**
   * A white panel behind each sponsor logo in the looping band. On by default,
   * because a dark wall swallows a dark logo entirely. Off puts the logos
   * straight onto the background — right for a set of light or knocked-out
   * logos supplied for exactly that.
   */
  sponsorChips?: boolean;
  /**
   * Give every sponsor logo an identical box instead of sizing each by area.
   * Off by default: equal areas make a wide wordmark and a square crest read as
   * the same weight, where equal boxes make the wordmark shout. On when an
   * organiser wants one uniform band whatever the shapes.
   */
  sponsorUniformSize?: boolean;
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
  /** Tennis team competitions: the nation this team is, as its ITF code (EGY, USA, ROU). */
  nation_code?: string | null;
  /** ISO 3166-1 alpha-2 code for the flag (eg, us, ro). Derived from the ITF code. */
  iso2?: string | null;
  captain_name?: string | null;
  players?: Player[];
}

/** The photo fields every person-shaped row carries. See src/lib/portrait.ts. */
export interface PhotoFields {
  /** The original photo. */
  photo_url: string | null;
  /** A transparent cut-out, preferred on the big broadcast cards. */
  portrait_url: string | null;
  /** 0-1 point that keeps the face in frame at any crop. */
  focal_x: number;
  focal_y: number;
}

export interface Player extends PhotoFields {
  id: string;
  tournament_id: string;
  team_id: string;
  player_order: number;
  full_name: string;
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
  /**
   * Which bracket a knockout match belongs to. Null for group and friendly
   * matches. Both tiers produce a 'final', so this is what tells them apart
   * everywhere a match is labelled, scoped or scored. See migration 0008.
   */
  bracket_id: string | null;
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
  /** @deprecated Superseded by `scoring_leases` (see src/lib/scoringControl.ts). Read/written by nothing since migration 0013. */
  active_scoring_device_id: string | null;
  is_pending_sync: boolean;
  started_at: string | null;
  ended_at: string | null;
  /** Tennis team competitions: the tie this match is a rubber of. See migration 0014. */
  tie_id?: string | null;
  /** 1-based position in the tie's order of play. */
  rubber_no?: number | null;
  rubber_type?: RubberType | null;
  /** The nominated players for this rubber, from the captains' line-ups. */
  team_a_player_ids?: string[] | null;
  team_b_player_ids?: string[] | null;
}

/**
 * A pending "please hand over control" request against a live lease. Cleared
 * the moment the holder accepts or declines it, or reassigns the lease to
 * someone else outright.
 */
export interface ScoringTransferRequest {
  deviceId: string;
  deviceLabel: string | null;
  requestedAt: string;
}

/**
 * One match's scoring lease — see src/lib/scoringControl.ts for the state
 * machine this row implements.
 */
export interface ScoringLease {
  id: string;
  match_id: string;
  tournament_id: string;
  device_id: string;
  device_label: string | null;
  revision: number;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
  released_at: string | null;
  transfer_request: ScoringTransferRequest | null;
}

export interface CompletedSet {
  teamAGames: number;
  teamBGames: number;
  tiebreak?: { a: number; b: number };
  /**
   * The set was a match tie-break played in place of a final set. It counts as
   * one game to the winner (1-0) and its points are in `tiebreak`: [10-8].
   */
  matchTiebreak?: boolean;
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
  /** The type of the final event in the most recent batch. */
  last_event_type?: string | null;
  last_event_team_id?: string | null;
  /**
   * The number of the most recent UNDO, 0 if none. Needed because events are
   * append-only: an undo's number is higher than the point it cancels.
   */
  last_undo_event_number?: number;
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
  /**
   * `plate` is the Plate bracket's equivalent of `qualified`: placed below the
   * Cup places but still playing. Without it, half the field reads as knocked
   * out on the public leaderboard the moment the group stage finishes.
   */
  status: "pending" | "qualified" | "plate" | "eliminated" | "disqualified";
  manual_status_override: boolean;
  /** Team competitions: rubbers won and lost across the group's ties. */
  rubbers_won?: number;
  rubbers_lost?: number;
}

export interface Bracket {
  id: string;
  tournament_id: string;
  /** Which of the two knockouts this is. See supabase/migrations/0008. */
  tier: BracketTier;
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

/**
 * What a screen is showing.
 *
 * `live_court` and `all_live` are the two pre-existing modes and stay valid so
 * saved screens keep working; both are read as `live`. One live mode is enough,
 * because a screen's coverage (`court_ids`) and its pin decide what it shows —
 * a separate mode saying the same thing is a third field that can disagree with
 * the other two.
 */
export type DisplayMode =
  | "live"
  | "leaderboard"
  | "bracket"
  | "winner"
  | "ceremony"
  | "sponsors"
  | "holding"
  | "live_court"
  | "all_live";

export type BracketTier = "cup" | "plate";

export interface ScreenSettings {
  id: string;
  tournament_id: string;
  /** Immutable once created: a TV may already be open on this URL. */
  screen_key: string;
  /** What the operator calls it. Renaming never changes the key. */
  screen_name: string | null;
  display_mode: DisplayMode;
  /** Courts this screen covers. Empty means every court. */
  court_ids: string[];
  /** Legacy single-court pin, still honoured as a fallback. */
  focus_court_id: string | null;
  /**
   * Pins the screen to one match. Together with `focus_court_id`, the absence
   * of both is what "follow live" means — there is no separate flag.
   */
  focus_match_id: string | null;
  /** Which bracket the bracket, winner and ceremony scenes show. */
  bracket_tier: BracketTier | "both";
  theme: "dark" | "light";
  sponsor_rotation_seconds: number;
  /** Bumped by every write; every writer checks it. */
  revision: number;
  break_started_at: string | null;
  break_ends_at: string | null;
  mute_animations: boolean;
  ceremony_step: number;
  ceremony_step_at: string | null;
  /**
   * An operator's replay of one match's entrance: when it was pressed, and the
   * match's last scoring event at that moment, so only a later point ends it.
   */
  entrance_replay: { match_id: string; at: string; event_number?: number } | null;
  updated_at?: string;
}

/** The live modes collapse to one; everything else is itself. */
export function normalizeDisplayMode(mode: DisplayMode): Exclude<DisplayMode, "live_court" | "all_live"> {
  return mode === "live_court" || mode === "all_live" ? "live" : mode;
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

/**
 * Who the public registration form accepts.
 *  - "individual": one player per submission (rotating formats need this).
 *  - "team": both players and a team name captured in one submission.
 *  - "either": the form offers both.
 */
export type RegistrationMode = "individual" | "team" | "either";

/**
 * How a referee records a match.
 *  - "point_by_point": the full scoring screen, every rally.
 *  - "final_score": enter the finished set score in one go.
 * Set per session; a referee may override it on an individual match.
 */
export type ScoringMode = "point_by_point" | "final_score";

/** How matches are drawn when a session's schedule is generated. */
export type MatchFormat = "rotating" | "group_stage" | "knockout";

export interface PlayerConsent {
  id: string;
  player_profile_id: string;
  channel: ConsentChannel;
  granted: boolean;
  granted_at: string | null;
  revoked_at: string | null;
  source: "registration" | "admin" | "player";
}

export interface PlayerProfile extends PhotoFields {
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
  /** Optional structured details — all admin-only, never public. */
  email: string | null;
  birth_year: number | null;
  /** Free-form so each club can use its own vocabulary (A/B/C, 1-7, …). */
  skill_level: string | null;
  gender: "male" | "female" | "other" | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Public projection of a profile — safe to send to unauthenticated pages. */
/**
 * What a public page is allowed to know about a person: a name and a face.
 * Never gains a mobile number, an email, or anything else admin-only.
 */
export interface PublicPlayer extends PhotoFields {
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
  /** Null means no fixed time box — the capacity estimate becomes advisory. */
  duration_minutes: number | null;
  registration_mode: RegistrationMode;
  scoring_mode: ScoringMode;
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
  /** Rejections are hidden rather than deleted, so they can be undone. */
  hidden: boolean;
  rejected_at: string | null;
  rejection_note: string | null;
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
