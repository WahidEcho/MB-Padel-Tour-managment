/**
 * The Move Score app's API contract: the JSON shapes /api/mobile/v1 returns.
 *
 * Pure types plus a few pure builders, shared by the server and the native app
 * (which imports this file directly), so the two can never drift apart.
 * Public shapes carry no private fields: no phone, notes, email or mobile number.
 */

import type { MatchRules, StageRuleKey } from "../types";
import type { NightTable, NightTableLayout } from "../friendly/nightTable";

export const API_VERSION = 1;

export type SideKey = "A" | "B";
export type MatchStatusLite =
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

export interface AppSkin {
  /** The event's own colours; the app derives its palette from them. */
  seedA?: string | null;
  seedB?: string | null;
  /** Preferred look inside the tournament. Users can still switch. */
  mode?: "dark" | "light" | null;
  artworkUrl?: string | null;
  logoUrl?: string | null;
}

export interface MTournamentCard {
  id: string;
  slug: string;
  name: string;
  sport: string;
  status: "draft" | "active" | "completed" | "archived";
  eventGroupId: string | null;
  venue: string | null;
  city: string | null;
  startsOn: string | null;
  endsOn: string | null;
  timezone: string;
  liveCount: number;
  /** Nations or teams entered. */
  teamCount: number;
  skin: AppSkin;
  /** The organisation running it (its page: /api/mobile/v1/orgs/{slug}). Absent from older servers. */
  organization?: MOrgRef | null;
}

export interface MOrgRef {
  slug: string;
  name: string;
}

export interface MEventGroup {
  id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  venue: string | null;
  city: string | null;
  startsOn: string | null;
  endsOn: string | null;
  timezone: string;
  artworkUrl: string | null;
  liveCount: number;
  tournaments: MTournamentCard[];
}

export interface MDiscover {
  generatedAt: string;
  featured: MEventGroup[];
  live: MTournamentCard[];
  upcoming: MTournamentCard[];
  past: MTournamentCard[];
}

export interface MPlayer {
  id: string;
  name: string;
  teamId: string;
  /** Null when the event shows no photos (the Junior Finals). */
  photoUrl: string | null;
}

export interface MTeam {
  id: string;
  name: string;
  /** ITF nation code for team competitions (USA); otherwise a short label. */
  code: string;
  /** Flag code (us). Null outside nation events. */
  iso2: string | null;
  seed: number | null;
  groupId: string | null;
  status: "active" | "disqualified" | "withdrawn";
  players: MPlayer[];
}

export interface MSponsor {
  name: string;
  logoUrl: string;
  aspect: number | null;
  tier: string | null;
}

/** A tournament's match-day switches as the app sees them. `on` is false until an organiser saves the Match day tab. */
export interface MMatchDay {
  on: boolean;
  /** The live courts hero on Discover, and whether only on the event's days. */
  showcase: boolean;
  eventDaysOnly: boolean;
  alerts: boolean;
  matchSoon: boolean;
  courtCall: boolean;
  /** Minutes players have to reach the court once called. */
  callMinutes: number;
  liveActivities: boolean;
  countdown: boolean;
  autoStartMine: boolean;
  autoStartStarred: boolean;
  widgets: boolean;
  imAtCourt: boolean;
  qrCheckIn: boolean;
  /** Warm-up timer length, or null when there is none. */
  warmUpMinutes: number | null;
}

/** The rules matches are played under, as every phone resolves them (see rulesForMatch in src/lib/tv/showcase.ts). */
export type MMatchRules = MatchRules;

/** A tournament's scoring rules per stage, resolved on the server so the app never reads the stored config. */
export interface MStageRules {
  /** The tournament's own rules: group stage, friendly matches and anything without an override. */
  base: MMatchRules;
  /** Every stage bucket with its overrides laid over the base (a blank Plate bucket inherits the Cup's). */
  stages: Record<StageRuleKey, MMatchRules>;
  /** Tennis doubles: laid over the stage's rules for a doubles match. Null for other sports. */
  doubles: Partial<MMatchRules> | null;
  /** Bracket ids that are the Plate, so a knockout match finds its bucket from `MMatch.bracketId`. */
  plateBrackets: string[];
}

/** One side's colour identity (src/lib/sides.ts): always a word with the colour, never colour alone. */
export interface MSide {
  /** "Red team" */
  label: string;
  /** "RED" */
  short: string;
  hex: string;
}

/** Red and blue teams: when `redBlue` is on, side A of every match is Red and side B Blue on screens and in calls. */
export interface MSides {
  redBlue: boolean;
  A: MSide;
  B: MSide;
}

export interface MBundle {
  version: string;
  tournament: MTournamentCard & {
    isTies: boolean;
    showPhotos: boolean;
    /** Rubber order for team competitions: ["S2","S1","D"]. */
    rubberPlan: string[];
    lowerThird: string | null;
    /** Match-day switches the app acts on (src/lib/matchday/rules.ts publicMatchDay). Absent from older servers. */
    matchDay?: MMatchDay;
    /**
     * A league night (Phase 8): its order of play per court with "about" times.
     * The app builds the table from the live matches with buildNightTable (@core).
     * Absent for tournaments and from older servers.
     */
    night?: MNightInfo;
  };
  teams: MTeam[];
  courts: { id: string; name: string; order: number }[];
  groups: { id: string; name: string; order: number }[];
  sponsors: { main: MSponsor | null; footer: MSponsor[] };
  /** Scoring rules per stage. Absent from older servers. */
  rules?: MStageRules;
  /** Red and blue team identity. Absent from older servers. */
  sides?: MSides;
}

/** A score as screens draw it. Sets are finished sets; `games` is the set in play. */
export interface MScore {
  sets: { a: number; b: number; tb?: { a: number; b: number } | null; mtb?: boolean }[];
  games: { a: number; b: number } | null;
  points: { a: string; b: string } | null;
  tiebreak: boolean;
  serving: SideKey | null;
  setsWon: { a: number; b: number };
  lastEventNumber: number;
  /** Bumps on every correction, so a screen can tell an undo from a point. */
  lastUndo: number;
  updatedAt: string | null;
}

export interface MMatch {
  id: string;
  tieId: string | null;
  rubberNo: number | null;
  rubberType: string | null;
  stage: string;
  groupId: string | null;
  round: string | null;
  order: number;
  courtId: string | null;
  scheduledTime: string | null;
  status: MatchStatusLite;
  a: string | null;
  b: string | null;
  /** Nominated players for a rubber; the whole team otherwise (empty = all). */
  aPlayers: string[];
  bPlayers: string[];
  winner: string | null;
  startedAt: string | null;
  endedAt: string | null;
  score: MScore | null;
  /** The knockout bracket, so the stage rules can tell the Plate from the Cup. Absent from older servers. */
  bracketId?: string | null;
}

/** What the next point could decide, from the engine and the match's own rules. */
export interface MSituation {
  kind: "match" | "set" | "break" | null;
  /** The side that would win it. */
  side: SideKey | null;
}

export interface MMatchDetail {
  match: MMatch;
  tournamentSlug: string;
  situation: MSituation;
}

export interface MTie {
  id: string;
  stage: "group" | "placement";
  groupId: string | null;
  roundNo: number;
  roundName: string | null;
  order: number;
  courtId: string | null;
  scheduledTime: string | null;
  a: string | null;
  b: string | null;
  status: "scheduled" | "live" | "completed";
  rubbersA: number;
  rubbersB: number;
  winner: string | null;
  placesFrom: number | null;
  placesTo: number | null;
  lineupLocked: boolean;
}

export interface MAnnouncement {
  id: string;
  title: string;
  body: string | null;
  level: "major" | "info";
  publishedAt: string;
}

export interface MLive {
  generatedAt: string;
  tournamentId: string;
  /** Equal to MBundle.version; when it changes the app reloads the bundle. */
  bundleVersion: string;
  ties: MTie[];
  matches: MMatch[];
  announcements: MAnnouncement[];
}

export interface MStandingRow {
  teamId: string;
  rank: number;
  played: number;
  won: number;
  lost: number;
  points: number;
  rubbersWon: number | null;
  rubbersLost: number | null;
  setsWon: number;
  setsLost: number;
  gamesWon: number;
  gamesLost: number;
  status: "pending" | "qualified" | "plate" | "eliminated" | "disqualified";
}

export interface MStandings {
  generatedAt: string;
  groups: { id: string; name: string; rows: MStandingRow[] }[];
  /** Final places once the placement rounds are decided. */
  placings: { place: number; teamId: string }[];
}

export interface MTimelinePoint {
  /** Who won the point. */
  w: SideKey;
  /** Games in the set after this point, when the point won a game: "5-4". */
  game?: string;
  /** Set number the point was played in (1-based). */
  set: number;
}

export interface MTimeline {
  matchId: string;
  points: MTimelinePoint[];
}

export interface MConfig {
  apiVersion: number;
  /** Builds older than this are asked to update. */
  minAppVersion: string;
  flags: Record<string, boolean>;
  /**
   * Whether the server can make each wallet's pass (its certificates are set).
   * Showing a wallet button is the flag's call (`apple_wallet`; Google is hidden in
   * the app for now); this only decides what tapping it does. Missing on older servers.
   */
  walletReady?: { apple: boolean; google: boolean };
  supportUrl: string;
  privacyUrl: string;
  /**
   * Sign-in providers switched on in Supabase Auth. Google signs in through the
   * in-app browser sheet, so its button shows as soon as this is true.
   */
  /** email and playerCode are absent from servers older than email sign-in. */
  signIn: { google: boolean; apple: boolean; email?: boolean; playerCode?: boolean };
}

/* ---------- the live courts hero (GET /api/mobile/v1/courts/live) ---------- */

/** A player on a court card: the public fields only, with the photo's focal point for big crops. */
export interface MCourtPlayer extends MPlayer {
  /** 0–1, where the face is: keeps it in frame at any crop. */
  focalX: number;
  focalY: number;
}

export interface MCourtTeam {
  id: string;
  name: string;
  code: string;
  iso2: string | null;
  players: MCourtPlayer[];
}

/** A match called to its court and not started yet (match_calls). Times are ISO strings. */
export interface MCourtCall {
  matchId: string;
  courtId: string | null;
  calledAt: string;
  /** The current deadline, extensions included. */
  deadlineAt: string;
  extensions: number;
  presentA: boolean;
  presentB: boolean;
}

/** One tournament on the hero: everything its court cards are drawn from. */
export interface MCourtsEvent {
  tournament: {
    id: string;
    slug: string;
    name: string;
    sport: string;
    timezone: string;
    eventGroupId: string | null;
    isTies: boolean;
    /** False at events that show no photos (the Junior Finals): every photoUrl is null then. */
    showPhotos: boolean;
    /** Part of a featured event group on Discover. */
    featured: boolean;
    skin: AppSkin;
    /** Players mark themselves at the court from their phone (Match day tab). Absent from older servers. */
    imAtCourt?: boolean;
  };
  rules: MStageRules;
  sides: MSides;
  /** Active courts, in court order. */
  courts: { id: string; name: string; order: number }[];
  /** Only the teams the matches and ties below name. */
  teams: MCourtTeam[];
  /** Ties on these courts (team competitions). */
  ties: MTie[];
  /** On court now, just finished, waiting next, and the rubbers of the ties above. */
  matches: MMatch[];
  /** Open court calls. Empty until the match-day engine calls a match. */
  calls: MCourtCall[];
}

export interface MCourtsLive {
  generatedAt: string;
  /** Featured events first, then every live tournament, in the Discover order set by Move Beyond. Empty when nothing is on. */
  events: MCourtsEvent[];
}

/* ---------- personal (never cached) ---------- */

export type FollowKind = "player" | "nation" | "tie" | "match" | "tournament" | "event_group" | "organization";

/** Every kind the server accepts (src/app/api/mobile/v1/me/follows). */
export const FOLLOW_KINDS: readonly FollowKind[] = ["player", "nation", "tie", "match", "tournament", "event_group", "organization"];

/* ---------- organisations (public) ---------- */

/**
 * An organisation's public page: its own profile, branding and tournaments.
 * Public fields only: never member emails, event codes, the application it sent,
 * its plan or billing.
 */
export interface MOrgProfile {
  generatedAt: string;
  organization: {
    slug: string;
    name: string;
    logoUrl: string | null;
    colors: { primary: string | null; accent: string | null };
    about: string | null;
    city: string | null;
    country: string | null;
    venues: { name: string; address: string | null; courts: number | null }[];
  };
  tournaments: { live: MTournamentCard[]; upcoming: MTournamentCard[]; past: MTournamentCard[] };
  /** Its public leagues (active and closed), newest first. */
  leagues: MLeagueCard[];
  /** "Top of all leagues" in this organisation for the current month; null when none of its leagues counts toward it. */
  topBoard: MTopBoard | null;
  /** Sections an older app showed as "coming". Leagues and boards arrived (Phase 7): always empty now. */
  comingSoon: ("leagues" | "boards")[];
}

/* ---------- leagues (public, Phase 7) ---------- */

export type MLeagueKind = "nights" | "season";
export type MJoinMode = "open" | "approval" | "paid" | "invite_code";
export type MMembershipStatus = "pending" | "awaiting_payment" | "active" | "removed";

/** A league in a list (an organisation's page, Leagues). */
export interface MLeagueCard {
  slug: string;
  name: string;
  sport: string;
  kind: MLeagueKind;
  status: "active" | "closed";
  organization: MOrgRef | null;
  divisions: number;
  members: number;
  /** The next night or fixture date ("YYYY-MM-DD", the league's own day), if any. */
  nextDate: string | null;
  joinModes: MJoinMode[];
}

/**
 * One line of a board. Public: a name and numbers only (never a profile id, a
 * phone, an email or a photo). An organisation that only matched a player by a
 * typed mobile sees the name typed on its own form (src/lib/orgs/personFields.ts).
 */
export interface MBoardLine {
  rank: number;
  name: string;
  points: number;
  wins: number;
  losses: number;
  played: number;
  gameDiff: number;
}

export interface MBoardPeriod {
  /** Months the board sums: 1 (monthly), 3, 6, 9 or 12. */
  length: number;
  label: string;
  /** The month asked for ("YYYY-MM") and the months the board covers. */
  month: string;
  months: string[];
}

export interface MLeagueDivision {
  id: string;
  name: string;
  members: number;
  board: MBoardLine[];
}

export interface MLeagueNight {
  date: string;
  name: string;
  /** Opens like a tournament (movescore://t/<slug>). */
  slug: string;
  liveCount: number;
  matches: number;
  finished: number;
  division: string;
  /** When the organiser published the night's table; null before. Absent from older servers. */
  publishedAt?: string | null;
  /**
   * The night's table (order of play per court, "about" times) for a night that
   * is on or coming up; null for the others. Side names only. Absent from older servers.
   */
  table?: MNightTable | null;
}

/** A night's table as every surface draws it (src/lib/friendly/nightTable.ts buildNightTable). */
export type MNightTable = NightTable;

export interface MNightInfo {
  /** When the organiser published the table; null while it is a draft. */
  publishedAt: string | null;
  /** How the table is laid out (the owner's reference layout is still to come). */
  layout: NightTableLayout;
}

export interface MLeagueFixture {
  date: string;
  round: number | null;
  division: string;
  home: string;
  away: string;
  status: "scheduled" | "live" | "finished";
  /** "6-4 6-3", when finished. */
  score: string | null;
  /** Opens the match (movescore://match/<id>) once it exists on a session the app shows. */
  matchId: string | null;
  slug: string | null;
}

export interface MLeague {
  generatedAt: string;
  league: {
    slug: string;
    name: string;
    about: string | null;
    sport: string;
    kind: MLeagueKind;
    status: "active" | "closed";
    timezone: string;
    organization: MOrgRef | null;
    joinModes: MJoinMode[];
    takingMembers: boolean;
    fee: { membership: string | null; perNight: string | null; payAtVenue: boolean };
    points: { win: number; draw: number; loss: number; walkoverWin: number; walkoverLoss: number; streak: { on: boolean; bonus: number; from: number; to: number } };
    boards: number[];
    yearStartMonth: number;
  };
  period: MBoardPeriod;
  /** The whole league's board for the period, then each division's. */
  board: MBoardLine[];
  divisions: MLeagueDivision[];
  nights: MLeagueNight[];
  fixtures: MLeagueFixture[];
}

/** "Top of all leagues": per organisation, or across the platform (organisations may opt out). */
export interface MTopBoard {
  generatedAt: string;
  scope: "organization" | "platform";
  organization: MOrgRef | null;
  month: string;
  lines: MBoardLine[];
}

/** The signed-in account in its leagues (also the data a league widget will use). */
export interface MMyLeague {
  slug: string;
  name: string;
  organization: MOrgRef | null;
  status: MMembershipStatus;
  division: string | null;
  payAtVenue: boolean;
  /** This month's board in the league. */
  month: string;
  rank: number | null;
  points: number;
}

export interface MMyLeagues {
  generatedAt: string;
  /** False when the account is not linked to a player profile yet (joining needs one). */
  profileLinked: boolean;
  leagues: MMyLeague[];
}

/** POST /leagues/<slug>/join. */
export interface MJoinResult {
  outcome: "joined" | "pending_approval" | "payment_required";
  status: MMembershipStatus;
  payAtVenue: boolean;
  message: string;
}

export interface MFollow {
  kind: FollowKind;
  key: string;
  tournamentId: string | null;
}

/**
 * The attendee's event pass. Staff accreditation is not on it (that is the referee
 * console): the server always answers edition "spectator" and staffRole null; both
 * stay in the shape for builds that still read them.
 */
export interface MPass {
  id: string;
  eventGroupId: string;
  serial: number;
  edition: "spectator" | "staff";
  staffRole: string | null;
  nationCode: string | null;
  holderName: string | null;
  onsiteUnlockedAt: string | null;
  stamps: string[];
  pins: string[];
  /** Matches checked in to with the match code. Missing from answers saved by older builds. */
  attendance?: MPassAttendance;
}

export interface MPassAttendance {
  /** Matches attended. */
  matches: number;
  /** All points on the pass (attendance today; the mini-game adds its own later). */
  points: number;
  /** Newest first, at most 50. */
  list: MAttendedMatch[];
}

export interface MAttendedMatch {
  matchId: string;
  checkedInAt: string;
  points: number;
  /** "EGY v JPN" style sides, as the bundle names them. */
  a: { name: string; code: string | null } | null;
  b: { name: string; code: string | null } | null;
  /** "Singles 1 · Final" */
  label: string;
}

/** POST /api/mobile/v1/matches/{matchId}/checkin, body { c } (court TV) or { p } (printed code). */
export interface MCheckInReply {
  status: "checked_in" | "already_checked_in";
  matchId: string;
  /** Points this check-in earned (0 when already checked in). */
  points: number;
  parts: { label: string; points: number }[];
  /** The event day stamped on the way (null outside the event's days or when already stamped). */
  stampedDay: string | null;
  pass: MPass;
}

/**
 * Refusals carry { error, code }: 400 bad_code, 410 code_expired, 409 too_early
 * (with opensAt, or null when the match has no time yet), 409 closed, 409 no_event,
 * 404 not_found, 429 rate_limited, 500 failed, 401 when the phone is not registered.
 */
export type MCheckInRefusal = "bad_code" | "code_expired" | "too_early" | "closed" | "no_event" | "not_found" | "rate_limited" | "failed";

export interface MAlertPrefs {
  scheduled: boolean;
  starting: boolean;
  live: boolean;
  finished: boolean;
  tie: boolean;
  major: boolean;
  /** Match day: your match is soon, you are called to court, the reminder. */
  court: boolean;
}

/** One tournament the signed-in player is entered in. */
export interface MMyPlayerEntry {
  playerId: string;
  tournamentId: string;
  tournamentSlug: string;
  tournamentName: string;
  sport: string;
  /** The tournament's own time zone, for match times. */
  timezone: string;
  teamId: string;
  teamName: string;
  /** ITF nation code (EGY) at nation events; null otherwise. */
  nationCode: string | null;
  iso2: string | null;
}

/** A match of the signed-in player, with the names a list row needs. */
export interface MMyMatch extends MMatch {
  tournamentSlug: string;
  tournamentName: string;
  aName: string | null;
  bName: string | null;
  /** The player's own side. */
  mySide: SideKey | null;
}

/**
 * The player an account is linked to with a player code (GET /me/player).
 * Private: carries the player's own phone, never shown to anyone else.
 */
export interface MMyPlayer {
  /** The player row whose code was entered. */
  playerId: string;
  name: string;
  nationCode: string | null;
  iso2: string | null;
  teamName: string;
  /** E.164, e.g. +201001234567. */
  phone: string | null;
  photoUrl: string | null;
  /** Every tournament this person is linked in, newest first. */
  entries: MMyPlayerEntry[];
  /** Soonest first; finished matches last. */
  matches: MMyMatch[];
}

/** Photo upload limits, shared so the app resizes to what the server accepts. */
export const PLAYER_PHOTO = { maxBytes: 1_500_000, maxSide: 2048, targetSide: 512, types: ["image/jpeg", "image/png", "image/webp"] } as const;

export const DEFAULT_ALERT_PREFS: MAlertPrefs = {
  scheduled: true,
  starting: true,
  live: false,
  finished: true,
  tie: true,
  major: true,
  court: true,
};

/** One row of the My matches home/lock-screen widget (GET /api/mobile/v1/me/widget). */
export interface MWidgetMatch {
  id: string;
  /** Short side labels (nation code or team name). */
  a: string;
  b: string;
  /** Scheduled start, epoch ms, or null. */
  at: number | null;
  court: string;
  phase: "upcoming" | "live" | "final";
  /** "6-4 3-2" (finished sets, then the current games). */
  sets: string;
  /** "30-15", live only. */
  points: string;
  /** The person plays in it (rather than starred it). */
  mine: boolean;
}

export interface MWidget {
  items: MWidgetMatch[];
  signedIn: boolean;
  /** Epoch ms the server built this. */
  updatedAt: number;
}

/* ---------- pure helpers shared by server and app ---------- */

/** Sets won from finished sets. */
export function setsWon(sets: MScore["sets"]): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const s of sets) {
    if (s.a > s.b) a++;
    else if (s.b > s.a) b++;
  }
  return { a, b };
}

/** "6–4 5–4" style summary, with the set in play last. */
export function scoreLine(score: MScore | null): string {
  if (!score) return "";
  const parts = score.sets.map((s) => (s.mtb && s.tb ? `[${s.tb.a}–${s.tb.b}]` : `${s.a}–${s.b}${s.tb ? `(${Math.min(s.tb.a, s.tb.b)})` : ""}`));
  if (score.games) parts.push(`${score.games.a}–${score.games.b}`);
  return parts.join(" ");
}

export function isLiveStatus(s: MatchStatusLite): boolean {
  return s === "live" || s === "paused";
}

export function isDoneStatus(s: MatchStatusLite): boolean {
  return s === "completed" || s === "walkover" || s === "disqualified" || s === "retired";
}
