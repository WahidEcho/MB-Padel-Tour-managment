/**
 * Match-day rules: what a tournament does on the day around its matches — the
 * live courts hero, player alerts, calling a match to court, the no-show prompt,
 * the lock screen, and how results are recorded.
 *
 * Stored in `tournaments.match_day_rules` (migration 0022). A row that was never
 * saved holds `{}` and reads as all off, so existing tournaments behave exactly as
 * before; a new tournament is created with DEFAULT_MATCH_DAY_RULES. `configured`
 * is what tells the two apart.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import type { MMatchDay } from "../mobile/contract";
import { sportOf, type SportDef } from "../sports/registry";

/** "either": the referee picks per match. */
export type ScoringModeChoice = "point_by_point" | "final_score" | "either";
export const SCORING_MODES: readonly ScoringModeChoice[] = ["point_by_point", "final_score", "either"];

export interface MatchDayRules {
  /** False until an organiser saves the Match day tab (stored `{}` = all off). */
  configured: boolean;
  /** The live courts hero on the app's Discover. */
  showcase: { on: boolean; eventDaysOnly: boolean };
  /** Match-day alerts to the players themselves. */
  alerts: { on: boolean };
  /** "Match soon": a side is one game from winning, so the next match gets ready. */
  matchSoon: { on: boolean; starredFans: boolean };
  /** Calling a match to its court: players have `minutes` to arrive, reminded `reminderMinutes` before the deadline. */
  courtCall: { on: boolean; autoOnRefereeOpen: boolean; minutes: number; reminderMinutes: number };
  /** A side not at court by the deadline: the referee is asked; each extension adds `extensionMinutes`. */
  noShow: { on: boolean; extensionMinutes: number; maxExtensions: number; bothAbsentPromptOnly: boolean };
  /** Live Activities on iPhone. */
  lockScreen: { liveActivities: boolean; startByPush: boolean; countdown: boolean; autoStartMine: boolean; autoStartStarred: boolean };
  widgets: { on: boolean };
  scoring: { mode: ScoringModeChoice };
  /**
   * Scoring v2 (games sports): each referee feature on or off, set by admins only
   * (Admin → Scoring features). A tournament that saved the Match day tab before
   * these existed gets them all on; an unsaved one has them all off.
   */
  features: ScoringFeatures;
  extras: {
    imAtCourt: boolean;
    qrCheckInPresent: boolean;
    warmUpTimer: boolean;
    warmUpMinutes: number;
    callOnTv: boolean;
    umpireVoiceCall: boolean;
    skipSoonIfBusy: boolean;
    quietOutsideEventDays: boolean;
    autoCallWithoutReferee: boolean;
    notifyBothOnResult: boolean;
  };
}

export interface ScoringFeatures {
  fault: boolean;
  ace: boolean;
  let: boolean;
  timerBetweenPoints: boolean;
  timerChangeover: boolean;
  timerSetBreak: boolean;
  breakStopwatch: boolean;
  bathroom: boolean;
  hydration: boolean;
  autoSwap: boolean;
  manualSwap: boolean;
  matchLog: boolean;
  doublesOrder: boolean;
  callMaster: boolean;
  tvTimers: boolean;
  tvAces: boolean;
}

export const SCORING_FEATURES_ON: ScoringFeatures = {
  fault: true,
  ace: true,
  let: true,
  timerBetweenPoints: true,
  timerChangeover: true,
  timerSetBreak: true,
  breakStopwatch: true,
  bathroom: true,
  hydration: true,
  autoSwap: true,
  manualSwap: true,
  matchLog: true,
  doublesOrder: true,
  callMaster: true,
  tvTimers: true,
  tvAces: true,
};

export const SCORING_FEATURES_OFF: ScoringFeatures = Object.fromEntries(
  Object.keys(SCORING_FEATURES_ON).map((k) => [k, false]),
) as unknown as ScoringFeatures;

/** The admin tab's rows, in order: [key, title, hint]. */
export const SCORING_FEATURE_GROUPS: { title: string; rows: [keyof ScoringFeatures, string, string][] }[] = [
  {
    title: "Referee buttons",
    rows: [
      ["fault", "Fault button", "Two faults score a double fault."],
      ["ace", "Ace button", "Point to the server, logged as an ace."],
      ["let", "Let button", "Serve let or replay the point."],
    ],
  },
  {
    title: "Timers",
    rows: [
      ["timerBetweenPoints", "25-second timer", "Shown after each point; red after 0:25, with rulings."],
      ["timerChangeover", "Changeover timer", "1:30 at a change of ends (Rule 29a)."],
      ["timerSetBreak", "Set break timer", "2:00 between sets."],
      ["breakStopwatch", "Break stopwatch", "Open stopwatch for other breaks."],
      ["bathroom", "Bathroom break", "Stopwatch, warns at 10:00."],
      ["hydration", "Hydration break", "Counts to 10:00."],
    ],
  },
  {
    title: "Sides & serve",
    rows: [
      ["autoSwap", "Auto swap sides at change of ends", "The point buttons swap when the players change ends."],
      ["manualSwap", "Manual swap", "Swap left / right from More."],
      ["doublesOrder", "Doubles server/receiver each set", "Asks the serve and receive order at the start of every set."],
    ],
  },
  {
    title: "Referee tools",
    rows: [
      ["matchLog", "Match log for referees", "Every point, call, violation and break."],
      ["callMaster", "Call master referee", "Alerts every master referee on duty."],
    ],
  },
  {
    title: "TV & app",
    rows: [
      ["tvTimers", "Show timers on TV & app", "Changeover, set break and break clocks."],
      ["tvAces", "Show aces on TV & app", "An ACE moment and the aces count."],
    ],
  },
];

/** New tournaments start with these. */
export const DEFAULT_MATCH_DAY_RULES: MatchDayRules = {
  configured: true,
  showcase: { on: true, eventDaysOnly: true },
  alerts: { on: true },
  matchSoon: { on: true, starredFans: false },
  courtCall: { on: true, autoOnRefereeOpen: true, minutes: 5, reminderMinutes: 2 },
  noShow: { on: true, extensionMinutes: 5, maxExtensions: 2, bothAbsentPromptOnly: true },
  lockScreen: { liveActivities: true, startByPush: true, countdown: true, autoStartMine: true, autoStartStarred: false },
  widgets: { on: true },
  scoring: { mode: "either" },
  features: SCORING_FEATURES_ON,
  extras: {
    imAtCourt: true,
    qrCheckInPresent: true,
    warmUpTimer: false,
    warmUpMinutes: 5,
    callOnTv: true,
    umpireVoiceCall: false,
    skipSoonIfBusy: true,
    quietOutsideEventDays: true,
    autoCallWithoutReferee: false,
    notifyBothOnResult: true,
  },
};

/** Tournaments that existed before match day, until an organiser saves the tab: everything as it was. */
export const OFF_MATCH_DAY_RULES: MatchDayRules = {
  configured: false,
  showcase: { on: false, eventDaysOnly: true },
  alerts: { on: false },
  matchSoon: { on: false, starredFans: false },
  courtCall: { on: false, autoOnRefereeOpen: false, minutes: 5, reminderMinutes: 2 },
  noShow: { on: false, extensionMinutes: 5, maxExtensions: 2, bothAbsentPromptOnly: true },
  lockScreen: { liveActivities: false, startByPush: false, countdown: false, autoStartMine: false, autoStartStarred: false },
  widgets: { on: false },
  scoring: { mode: "point_by_point" },
  features: SCORING_FEATURES_OFF,
  extras: {
    imAtCourt: false,
    qrCheckInPresent: false,
    warmUpTimer: false,
    warmUpMinutes: 5,
    callOnTv: false,
    umpireVoiceCall: false,
    skipSoonIfBusy: true,
    quietOutsideEventDays: true,
    autoCallWithoutReferee: false,
    notifyBothOnResult: false,
  },
};

export const MINUTES_RANGE = { min: 1, max: 30 } as const;
export const EXTENSIONS_RANGE = { min: 0, max: 5 } as const;

/** Fields that are minutes (clamped to MINUTES_RANGE) or counts of extensions (EXTENSIONS_RANGE). */
const MINUTE_FIELDS = new Set(["minutes", "reminderMinutes", "extensionMinutes", "warmUpMinutes"]);
const EXTENSION_FIELDS = new Set(["maxExtensions"]);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One group: only the keys the default has, each only when of the default's type. Unknown keys are dropped. */
function group<T extends object>(base: T, raw: unknown): T {
  const out = { ...base } as Record<string, unknown>;
  if (!isRecord(raw)) return out as T;
  for (const [k, def] of Object.entries(base)) {
    const v = raw[k];
    if (typeof def === "boolean" && typeof v === "boolean") out[k] = v;
    else if (typeof def === "number" && typeof v === "number" && Number.isFinite(v)) {
      out[k] = MINUTE_FIELDS.has(k)
        ? clamp(v, MINUTES_RANGE.min, MINUTES_RANGE.max)
        : EXTENSION_FIELDS.has(k)
          ? clamp(v, EXTENSIONS_RANGE.min, EXTENSIONS_RANGE.max)
          : v;
    } else if (k === "mode" && SCORING_MODES.includes(v as ScoringModeChoice)) out[k] = v;
  }
  return out as T;
}

/** Switches off what the sport cannot do, whatever was stored. */
function forSport(r: MatchDayRules, sport: SportDef): MatchDayRules {
  const s = sport.supports;
  return {
    ...r,
    showcase: s.showcase ? r.showcase : { ...r.showcase, on: false },
    matchSoon: s.nearEnd ? r.matchSoon : { on: false, starredFans: false },
    lockScreen: s.liveActivity
      ? r.lockScreen
      : { liveActivities: false, startByPush: false, countdown: false, autoStartMine: false, autoStartStarred: false },
    widgets: s.liveActivity ? r.widgets : { on: false },
    scoring: s.finalScore ? r.scoring : { mode: "point_by_point" },
    features: sport.engine === "games" ? r.features : SCORING_FEATURES_OFF,
    extras: s.voice ? r.extras : { ...r.extras, umpireVoiceCall: false },
  };
}

/**
 * The rules a tournament runs under, from whatever is stored. Never throws: an
 * unsaved row (`{}`, null, junk) is OFF_MATCH_DAY_RULES; a saved one keeps only
 * known keys of the right type, with minutes clamped to 1–30 and extensions to
 * 0–5, and anything the sport does not support switched off.
 */
export function matchDayRules(raw: unknown, sport?: { sport?: string | null } | string | null): MatchDayRules {
  if (!isRecord(raw) || raw.configured !== true) return OFF_MATCH_DAY_RULES;
  const d = DEFAULT_MATCH_DAY_RULES;
  const rules: MatchDayRules = {
    configured: true,
    showcase: group(d.showcase, raw.showcase),
    alerts: group(d.alerts, raw.alerts),
    matchSoon: group(d.matchSoon, raw.matchSoon),
    courtCall: group(d.courtCall, raw.courtCall),
    noShow: group(d.noShow, raw.noShow),
    lockScreen: group(d.lockScreen, raw.lockScreen),
    widgets: group(d.widgets, raw.widgets),
    scoring: group(d.scoring, raw.scoring),
    features: group(d.features, raw.features),
    extras: group(d.extras, raw.extras),
  };
  return forSport(rules, sportOf(sport));
}

/** The rules a new tournament of this sport is created with. */
export function newTournamentMatchDayRules(sport: string): MatchDayRules {
  return matchDayRules(DEFAULT_MATCH_DAY_RULES, sport);
}

/** What the app's public bundle carries: only what a phone acts on, nothing about referees' prompts. */
export function publicMatchDay(r: MatchDayRules): MMatchDay {
  return {
    on: r.configured,
    showcase: r.showcase.on,
    eventDaysOnly: r.showcase.eventDaysOnly,
    alerts: r.alerts.on,
    matchSoon: r.matchSoon.on,
    courtCall: r.courtCall.on,
    callMinutes: r.courtCall.minutes,
    liveActivities: r.lockScreen.liveActivities,
    countdown: r.lockScreen.countdown,
    autoStartMine: r.lockScreen.autoStartMine,
    autoStartStarred: r.lockScreen.autoStartStarred,
    widgets: r.widgets.on,
    imAtCourt: r.extras.imAtCourt,
    qrCheckIn: r.extras.qrCheckInPresent,
    warmUpMinutes: r.extras.warmUpTimer ? r.extras.warmUpMinutes : null,
  };
}

/**
 * How a match is recorded. A match's own override wins, then its friendly
 * session's mode (unless the session says "either"), then the tournament's rules.
 */
export function resolveScoringMode(opts: {
  matchOverride?: string | null;
  sessionMode?: string | null;
  rules: MatchDayRules;
}): ScoringModeChoice {
  const pick = (v: string | null | undefined) => (SCORING_MODES.includes(v as ScoringModeChoice) ? (v as ScoringModeChoice) : null);
  const override = pick(opts.matchOverride);
  if (override && override !== "either") return override;
  const session = pick(opts.sessionMode);
  if (session && session !== "either") return session;
  return opts.rules.scoring.mode;
}
