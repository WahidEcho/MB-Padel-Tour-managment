/**
 * A league's settings as stored (Phase 7): its periods and boards, fees, the
 * night template new nights are created from, and its status. Every reader goes
 * through these sanitisers, so a junk or missing field never breaks a page: it
 * takes the default.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import { BOARD_LENGTHS, type BoardLength } from "./boards";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function int(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/* ---------------- kind and status ---------------- */

export const LEAGUE_KINDS = ["nights", "season"] as const;
export type LeagueKind = (typeof LEAGUE_KINDS)[number];
export const isLeagueKind = (v: unknown): v is LeagueKind => typeof v === "string" && (LEAGUE_KINDS as readonly string[]).includes(v);

export const LEAGUE_STATUSES = ["draft", "active", "closed", "archived"] as const;
export type LeagueStatus = (typeof LEAGUE_STATUSES)[number];
export const isLeagueStatus = (v: unknown): v is LeagueStatus => typeof v === "string" && (LEAGUE_STATUSES as readonly string[]).includes(v);

/** Shown in the app: an active league, and a closed one (its boards stay readable). */
export const PUBLIC_LEAGUE_STATUSES: readonly LeagueStatus[] = ["active", "closed"];
/** Taking members: active only. */
export const leagueTakesMembers = (status: string) => status === "active";

export const LEAGUE_STATUS_LABELS: Record<LeagueStatus, string> = {
  draft: "Draft (not public)",
  active: "Active",
  closed: "Closed (boards stay public)",
  archived: "Archived (hidden)",
};

/* ---------------- periods and boards ---------------- */

export interface LeaguePeriods {
  /** The monthly board is always kept; it resets every month. */
  monthly: true;
  /** Boards the league shows, in months (1 = the monthly board). Always includes 1. */
  boards: BoardLength[];
  /** 1–12: the month the league's year starts in (3/6/9/12-month boards are blocks of it). */
  yearStartMonth: number;
}

export const DEFAULT_LEAGUE_PERIODS: LeaguePeriods = { monthly: true, boards: [1, 3, 12], yearStartMonth: 1 };

export function leaguePeriods(raw: unknown): LeaguePeriods {
  if (!isRecord(raw)) return { ...DEFAULT_LEAGUE_PERIODS, boards: [...DEFAULT_LEAGUE_PERIODS.boards] };
  const list = Array.isArray(raw.boards) ? raw.boards.map((b) => (typeof b === "string" ? Number(b) : b)) : DEFAULT_LEAGUE_PERIODS.boards;
  const boards = BOARD_LENGTHS.filter((l) => l === 1 || list.includes(l));
  return { monthly: true, boards, yearStartMonth: int(raw.year_start_month ?? raw.yearStartMonth, 1, 1, 12) };
}

export function storedLeaguePeriods(p: LeaguePeriods): Record<string, unknown> {
  return { monthly: true, boards: [...p.boards], year_start_month: p.yearStartMonth };
}

export const BOARD_LABELS: Record<BoardLength, string> = { 1: "This month", 3: "3 months", 6: "6 months", 9: "9 months", 12: "Year" };

/* ---------------- fees ---------------- */

export interface LeagueMoney {
  amount: number;
  currency: string;
}

export interface LeagueFee {
  /** Paid once to join (the "paid" join mode). */
  membership: LeagueMoney | null;
  /** Paid per night played (shown; collected at the venue). */
  perNight: LeagueMoney | null;
}

function money(raw: unknown): LeagueMoney | null {
  if (!isRecord(raw)) return null;
  const amount = int(raw.amount, 0, 0, 1_000_000);
  if (amount <= 0) return null;
  const c = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
  return { amount, currency: /^[A-Z]{3}$/.test(c) ? c : "EGP" };
}

export function leagueFee(raw: unknown): LeagueFee {
  if (!isRecord(raw)) return { membership: null, perNight: null };
  return { membership: money(raw.membership), perNight: money(raw.per_night ?? raw.perNight) };
}

export function storedLeagueFee(f: LeagueFee): Record<string, unknown> {
  return { membership: f.membership, per_night: f.perNight };
}

export function moneyLabel(m: LeagueMoney | null): string | null {
  return m ? `${m.amount.toLocaleString("en-GB")} ${m.currency}` : null;
}

/* ---------------- night template ---------------- */

export type NightPairing = "americano" | "mexicano" | "fixed";
export type NightRanking = "win_points" | "games_won";
export type NightScoring = "point_by_point" | "final_score" | "either";

export interface NightTemplate {
  /** "HH:MM", local to the league's time zone. */
  startTime: string;
  durationMinutes: number;
  courts: number;
  pairingMode: NightPairing;
  rankingModel: NightRanking;
  setsToWinMatch: number;
  gamesToWinSet: number;
  maxPlayers: number | null;
  scoringMode: NightScoring;
}

export const DEFAULT_NIGHT_TEMPLATE: NightTemplate = {
  startTime: "19:00",
  durationMinutes: 120,
  courts: 2,
  pairingMode: "americano",
  rankingModel: "win_points",
  setsToWinMatch: 1,
  gamesToWinSet: 6,
  maxPlayers: null,
  scoringMode: "either",
};

function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function nightTemplate(raw: unknown): NightTemplate {
  const d = DEFAULT_NIGHT_TEMPLATE;
  if (!isRecord(raw)) return { ...d };
  const time = typeof raw.start_time === "string" ? raw.start_time : typeof raw.startTime === "string" ? raw.startTime : "";
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  const max = raw.max_players ?? raw.maxPlayers;
  return {
    startTime: m ? `${m[1]}:${m[2]}` : d.startTime,
    durationMinutes: int(raw.duration_minutes ?? raw.durationMinutes, d.durationMinutes, 30, 600),
    courts: int(raw.courts, d.courts, 1, 20),
    pairingMode: oneOf(raw.pairing_mode ?? raw.pairingMode, ["americano", "mexicano", "fixed"] as const, d.pairingMode),
    rankingModel: oneOf(raw.ranking_model ?? raw.rankingModel, ["win_points", "games_won"] as const, d.rankingModel),
    setsToWinMatch: int(raw.sets_to_win_match ?? raw.setsToWinMatch, d.setsToWinMatch, 1, 3),
    gamesToWinSet: int(raw.games_to_win_set ?? raw.gamesToWinSet, d.gamesToWinSet, 1, 9),
    maxPlayers: max === null || max === undefined || max === "" ? null : int(max, 0, 4, 200) || null,
    scoringMode: oneOf(raw.scoring_mode ?? raw.scoringMode, ["point_by_point", "final_score", "either"] as const, d.scoringMode),
  };
}

export function storedNightTemplate(t: NightTemplate): Record<string, unknown> {
  return {
    start_time: t.startTime,
    duration_minutes: t.durationMinutes,
    courts: t.courts,
    pairing_mode: t.pairingMode,
    ranking_model: t.rankingModel,
    sets_to_win_match: t.setsToWinMatch,
    games_to_win_set: t.gamesToWinSet,
    max_players: t.maxPlayers,
    scoring_mode: t.scoringMode,
  };
}

/* ---------------- dates ---------------- */

export const isIsoDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export const isMonth = (v: unknown): v is string => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** "2026-11-04" plus n days. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Tue 4 Nov 2026" for a "YYYY-MM-DD" (a calendar day, no time zone involved). */
export function dayLabel(date: string): string {
  if (!isIsoDate(date)) return date;
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** "November 2026" for "2026-11". */
export function monthLabel(month: string): string {
  if (!isMonth(month)) return month;
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });
}

/** The month before or after "YYYY-MM". */
export function shiftMonth(month: string, by: number): string {
  if (!isMonth(month)) return month;
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + by;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/* ---------------- slugs ---------------- */

/** A league slug from its name plus a short random tail (unique across the platform). */
export function leagueSlug(name: string, tail: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "league";
  return `${base}-${tail.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "x"}`;
}

export const isLeagueSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$/.test(s);
