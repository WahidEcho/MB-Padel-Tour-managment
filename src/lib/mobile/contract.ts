/**
 * The Move Score app's API contract: the JSON shapes /api/mobile/v1 returns.
 *
 * Pure types plus a few pure builders, shared by the server and the native app
 * (which imports this file directly), so the two can never drift apart.
 * Public shapes carry no private fields: no phone, notes, email or mobile number.
 */

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

export interface MBundle {
  version: string;
  tournament: MTournamentCard & {
    isTies: boolean;
    showPhotos: boolean;
    /** Rubber order for team competitions: ["S2","S1","D"]. */
    rubberPlan: string[];
    lowerThird: string | null;
  };
  teams: MTeam[];
  courts: { id: string; name: string; order: number }[];
  groups: { id: string; name: string; order: number }[];
  sponsors: { main: MSponsor | null; footer: MSponsor[] };
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
  supportUrl: string;
  privacyUrl: string;
  /**
   * Sign-in providers switched on in Supabase Auth. Google signs in through the
   * in-app browser sheet, so its button shows as soon as this is true.
   */
  signIn: { google: boolean; apple: boolean };
}

/* ---------- personal (never cached) ---------- */

export type FollowKind = "player" | "nation" | "tie" | "match" | "tournament" | "event_group";

export interface MFollow {
  kind: FollowKind;
  key: string;
  tournamentId: string | null;
}

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
}

export interface MAlertPrefs {
  scheduled: boolean;
  starting: boolean;
  live: boolean;
  finished: boolean;
  tie: boolean;
  major: boolean;
}

export const DEFAULT_ALERT_PREFS: MAlertPrefs = {
  scheduled: true,
  starting: true,
  live: false,
  finished: true,
  tie: true,
  major: true,
};

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
