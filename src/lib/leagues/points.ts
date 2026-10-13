/**
 * League points (Phase 7): what each player banks from each league match.
 *
 * Every league has its own editable rule set (defaults: win 2, loss 1; walkover
 * win and loss configurable; a streak bonus that is off unless switched on). A
 * player's streak belongs to the league: wins in another league or in a
 * stand-alone friendly session (whose 3 / 0 + fire rules are unchanged, see
 * src/lib/friendly/fire.ts) neither extend nor break it.
 *
 * The streak follows the friendly fire rules, so players meet one behaviour:
 *   played win      streak + 1; the win numbered `from`..`to` of a streak earns `bonus`
 *   played loss     streak back to 0
 *   draw (chess)    `draw` points, streak back to 0 (a draw is not a win)
 *   walkover win    walkover points, streak frozen (neither advances nor breaks)
 *   walkover loss   walkover points, streak back to 0
 *   void            nothing (no row)
 *
 * A result counts in the month of its night or fixture date in the league's time
 * zone, not the moment it was entered. Points count at once; reopening a match
 * removes its rows and re-evaluates the streak bonuses after it
 * (`reopenLeagueMatch`), because a bonus depends on the results before it.
 * Rows are unique per match + player.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import { eventDay } from "../matchday/eventDay";

/** "draw" is for sports that have them (chess): a finished result for both players. */
export type LeagueResultKind = "win" | "draw" | "loss" | "walkover_win" | "walkover_loss" | "void";

export interface LeagueStreakRule {
  on: boolean;
  /** Points added for each qualifying win. */
  bonus: number;
  /** The first win of a streak that earns the bonus (2 = from the second win in a row). */
  from: number;
  /** The last win of a streak that earns it. */
  to: number;
}

export interface LeaguePointsRules {
  win: number;
  /** Chess and other sports with draws. Default halfway between win and loss. */
  draw: number;
  loss: number;
  walkoverWin: number;
  walkoverLoss: number;
  streak: LeagueStreakRule;
}

export const DEFAULT_LEAGUE_POINTS_RULES: LeaguePointsRules = {
  win: 2,
  draw: 1.5,
  loss: 1,
  walkoverWin: 2,
  walkoverLoss: 0,
  streak: { on: false, bonus: 1, from: 2, to: 11 },
};

export const POINTS_RANGE = { min: 0, max: 100 } as const;
export const STREAK_RANGE = { min: 1, max: 1000 } as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function int(v: unknown, fallback: number, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/** Points: halves allowed (a chess draw), 0–100. */
function pts(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(POINTS_RANGE.max, Math.max(POINTS_RANGE.min, Math.round(v * 2) / 2));
}

/**
 * The rules a league runs under, from whatever is stored (`leagues.points_rules`).
 * Never throws: missing or junk fields take the defaults, points are 0–100 in
 * halves, streak bounds 1–1000 with `to` never below `from`. Stored keys
 * use snake_case for the walkover fields (`walkover_win`), camelCase is accepted too.
 */
export function leaguePointsRules(raw: unknown): LeaguePointsRules {
  const d = DEFAULT_LEAGUE_POINTS_RULES;
  if (!isRecord(raw)) return { ...d, streak: { ...d.streak } };
  const p = (key: string, alt: string, fallback: number) => pts(raw[key] ?? raw[alt], fallback);
  const s = isRecord(raw.streak) ? raw.streak : {};
  const from = int(s.from, d.streak.from, STREAK_RANGE.min, STREAK_RANGE.max);
  const to = Math.max(from, int(s.to, d.streak.to, STREAK_RANGE.min, STREAK_RANGE.max));
  return {
    win: p("win", "win", d.win),
    draw: p("draw", "draw", d.draw),
    loss: p("loss", "loss", d.loss),
    walkoverWin: p("walkover_win", "walkoverWin", d.walkoverWin),
    walkoverLoss: p("walkover_loss", "walkoverLoss", d.walkoverLoss),
    streak: {
      on: typeof s.on === "boolean" ? s.on : d.streak.on,
      bonus: pts(s.bonus, d.streak.bonus),
      from,
      to,
    },
  };
}

/** The stored form of the rules (snake_case walkover keys, as the migration names them). */
export function storedLeaguePointsRules(r: LeaguePointsRules): Record<string, unknown> {
  return { win: r.win, draw: r.draw, loss: r.loss, walkover_win: r.walkoverWin, walkover_loss: r.walkoverLoss, streak: { ...r.streak } };
}

/** One player's result in one league match. */
export interface LeagueResult {
  matchId: string;
  profileId: string;
  kind: LeagueResultKind;
  /** The night or fixture date: "YYYY-MM-DD" (taken as the league's own day) or an ISO instant. */
  date: string;
  /** When the match ended, to order the matches of one night (ISO or epoch ms). Ties fall back to the match id. */
  endedAt?: string | number | null;
}

export interface LeaguePointsRow {
  matchId: string;
  profileId: string;
  kind: Exclude<LeagueResultKind, "void">;
  /** "YYYY-MM": the night or fixture date's month in the league's zone. */
  month: string;
  components: { base: number; streak: number };
  points: number;
  /** The player's league streak after this result. */
  streakAfter: number;
}

/** The month a result counts in: the night or fixture date's month in the league's zone. */
export function resultMonth(date: string, timeZone: string): string {
  return resultDay(date, timeZone).slice(0, 7);
}

function resultDay(date: string, timeZone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const at = Date.parse(date);
  if (!Number.isFinite(at)) return "0000-00-00";
  try {
    return eventDay(timeZone || "Africa/Cairo", at);
  } catch {
    return eventDay("Africa/Cairo", at);
  }
}

function instant(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return Infinity;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : Infinity;
}

export function leaguePointsKey(matchId: string, profileId: string): string {
  return `${matchId}|${profileId}`;
}

/**
 * Every player's points rows for a league's results, in play order. Results with
 * the same match + player are one result: the last one given wins (a correction).
 */
export function leaguePoints(
  rulesRaw: LeaguePointsRules | unknown,
  results: LeagueResult[],
  timeZone: string,
): { rows: LeaguePointsRow[]; streaks: Map<string, number> } {
  const rules = leaguePointsRules(rulesRaw);
  const unique = new Map<string, LeagueResult>();
  for (const r of results) unique.set(leaguePointsKey(r.matchId, r.profileId), r);

  const ordered = [...unique.values()]
    .map((r) => ({ r, day: resultDay(r.date, timeZone), at: instant(r.endedAt) }))
    .sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0) || x.at - y.at || x.r.matchId.localeCompare(y.r.matchId));

  const streaks = new Map<string, number>();
  const rows: LeaguePointsRow[] = [];
  for (const { r, day } of ordered) {
    if (r.kind === "void") continue;
    const before = streaks.get(r.profileId) ?? 0;
    let base = 0;
    let bonus = 0;
    let after = before;
    switch (r.kind) {
      case "win":
        base = rules.win;
        after = before + 1;
        if (rules.streak.on && after >= rules.streak.from && after <= rules.streak.to) bonus = rules.streak.bonus;
        break;
      case "draw":
        base = rules.draw;
        after = 0;
        break;
      case "loss":
        base = rules.loss;
        after = 0;
        break;
      case "walkover_win":
        base = rules.walkoverWin;
        break;
      case "walkover_loss":
        base = rules.walkoverLoss;
        after = 0;
        break;
    }
    streaks.set(r.profileId, after);
    rows.push({
      matchId: r.matchId,
      profileId: r.profileId,
      kind: r.kind,
      month: day.slice(0, 7),
      components: { base, streak: bonus },
      points: base + bonus,
      streakAfter: after,
    });
  }
  return { rows, streaks };
}

export interface LeaguePointsChange {
  /** Rows to delete, by match + player. */
  remove: { matchId: string; profileId: string }[];
  /** Rows to insert or replace (on conflict match + player). */
  upsert: LeaguePointsRow[];
}

function sameRow(a: LeaguePointsRow, b: LeaguePointsRow): boolean {
  return (
    a.kind === b.kind &&
    a.month === b.month &&
    a.points === b.points &&
    a.components.base === b.components.base &&
    a.components.streak === b.components.streak &&
    a.streakAfter === b.streakAfter
  );
}

/** What turns the stored rows into the wanted ones, touching only rows that change. */
export function diffLeaguePoints(existing: LeaguePointsRow[], wanted: LeaguePointsRow[]): LeaguePointsChange {
  const want = new Map(wanted.map((r) => [leaguePointsKey(r.matchId, r.profileId), r]));
  const have = new Map(existing.map((r) => [leaguePointsKey(r.matchId, r.profileId), r]));
  const remove = [...have.entries()]
    .filter(([k]) => !want.has(k))
    .map(([, r]) => ({ matchId: r.matchId, profileId: r.profileId }));
  const upsert = [...want.entries()].filter(([k, r]) => !have.has(k) || !sameRow(have.get(k)!, r)).map(([, r]) => r);
  return { remove, upsert };
}

/**
 * A finished match was reopened (undo, correction): its rows go, and any later
 * streak bonus that depended on it is re-evaluated. `results` are the league's
 * results as they stand, the reopened match's still among them or not.
 */
export function reopenLeagueMatch(
  rules: LeaguePointsRules | unknown,
  results: LeagueResult[],
  existing: LeaguePointsRow[],
  matchId: string,
  timeZone: string,
): LeaguePointsChange {
  const { rows } = leaguePoints(rules, results.filter((r) => r.matchId !== matchId), timeZone);
  return diffLeaguePoints(existing, rows);
}

/** A match was finalised (or re-finalised after a correction): its rows and any later bonus that changes. */
export function applyLeagueMatch(
  rules: LeaguePointsRules | unknown,
  results: LeagueResult[],
  existing: LeaguePointsRow[],
  timeZone: string,
): LeaguePointsChange {
  return diffLeaguePoints(existing, leaguePoints(rules, results, timeZone).rows);
}

/** The result kind for one player of a finished match. */
export function leagueResultKind(opts: { won: boolean; walkover: boolean; void?: boolean; draw?: boolean }): LeagueResultKind {
  if (opts.void) return "void";
  if (opts.draw) return "draw";
  if (opts.walkover) return opts.won ? "walkover_win" : "walkover_loss";
  return opts.won ? "win" : "loss";
}
