/**
 * What each sport is, in one place: its scoring engine, its default rules, the
 * words its screens use, and which platform features it takes part in.
 *
 * Code asks `sportOf(t)` instead of comparing `t.sport` to a string, so a new
 * sport is one entry here rather than a hunt through every string comparison
 * of `t.sport` (registry.test.ts holds that count and lets it only go down).
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import { DEFAULT_SCORING_CONFIG, DEFAULT_TENNIS_SCORING_CONFIG, type ScoringConfig } from "../types";

export type SportEngine = "games" | "chess";

export interface SportNouns {
  /** One entrant: a team, a nation's side, a chess player. */
  side: string;
  sides: string;
  match: string;
  matches: string;
  court: string;
  courts: string;
}

export interface SportSupports {
  /** Team competitions of rubbers (nations, ties). */
  ties: boolean;
  /** The live courts hero on the app's Discover. */
  showcase: boolean;
  /** A result may be entered as a final score instead of point by point. */
  finalScore: boolean;
  /** "Match soon": a side is one game from winning. */
  nearEnd: boolean;
  /** Live Activities and widgets on the lock screen. */
  liveActivity: boolean;
  /** Umpire voice calls. */
  voice: boolean;
  /** The toss before the first point in the chair umpire's console (scoring/toss.ts). */
  toss: boolean;
}

export interface SportDef {
  id: string;
  label: string;
  engine: SportEngine;
  defaultRules: ScoringConfig;
  nouns: SportNouns;
  supports: SportSupports;
  /**
   * The scoring features (Fault, Ace, Let, timers, doubles serve order…) are on for a
   * tournament whose admins have not saved its Scoring features tab yet. Tennis only:
   * the features follow the ITF rules; other sports keep them off until switched on.
   */
  scoringFeaturesByDefault?: boolean;
}

const GAMES_NOUNS: SportNouns = { side: "Team", sides: "Teams", match: "Match", matches: "Matches", court: "Court", courts: "Courts" };

export const SPORTS: Readonly<Record<"padel" | "tennis" | "chess", SportDef>> = {
  padel: {
    id: "padel",
    label: "Padel",
    engine: "games",
    defaultRules: DEFAULT_SCORING_CONFIG,
    nouns: GAMES_NOUNS,
    supports: { ties: false, showcase: true, finalScore: true, nearEnd: true, liveActivity: true, voice: true, toss: true },
  },
  tennis: {
    id: "tennis",
    label: "Tennis",
    engine: "games",
    defaultRules: DEFAULT_TENNIS_SCORING_CONFIG,
    nouns: GAMES_NOUNS,
    supports: { ties: true, showcase: true, finalScore: true, nearEnd: true, liveActivity: true, voice: true, toss: true },
    scoringFeaturesByDefault: true,
  },
  chess: {
    id: "chess",
    label: "Chess",
    engine: "chess",
    // Chess has no games-and-sets score; the default is only there so every sport has one.
    defaultRules: DEFAULT_SCORING_CONFIG,
    nouns: { side: "Player", sides: "Players", match: "Game", matches: "Games", court: "Board", courts: "Boards" },
    supports: { ties: false, showcase: false, finalScore: true, nearEnd: false, liveActivity: false, voice: false, toss: false },
  },
};

/** Any other sport scored in games and sets, with the conservative feature set. */
function genericSport(id: string): SportDef {
  const label = id ? id.charAt(0).toUpperCase() + id.slice(1) : "Games";
  return {
    id: id || "games",
    label,
    engine: "games",
    defaultRules: DEFAULT_SCORING_CONFIG,
    nouns: GAMES_NOUNS,
    supports: { ties: false, showcase: true, finalScore: true, nearEnd: true, liveActivity: true, voice: false, toss: false },
  };
}

/** The sport of a tournament (or a sport id); unknown sports fall back to a generic games sport. */
export function sportOf(t: { sport?: string | null } | string | null | undefined): SportDef {
  const id = (typeof t === "string" ? t : t?.sport ?? "").trim().toLowerCase();
  return (SPORTS as Record<string, SportDef>)[id] ?? genericSport(id);
}
