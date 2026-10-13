/**
 * League boards (Phase 7): who leads a league, an organisation and the platform.
 *
 *   monthly          one month's points; resets every month
 *   3/6/9/12 months  sums of months. By default the blocks of the league year
 *                    that the month falls in, the year starting in the league's
 *                    `year_start_month` (3 months from September: Sep–Nov,
 *                    Dec–Feb, Mar–May, Jun–Aug). Nine does not divide a year, so
 *                    a 9-month board is months 1–9 of the league year and then
 *                    the 3 months left. `mode: "rolling"` gives the last N months
 *                    ending at the month instead.
 *   top of all       per organisation and platform-wide: a player's total points
 *                    over every league that counts toward it, for a month.
 *                    Organisations may opt out of the platform board.
 *
 * Order and ties follow the friendly rankings (src/lib/friendly/ranking.ts):
 * total points → wins → game difference → games won; players still level share
 * the rank (1, 2, 2, 4) and are listed by profile id.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import type { LeaguePointsRow } from "./points";

/** One player's points from one source (a league_points row, or a sum of them). */
export interface BoardEntry {
  profileId: string;
  /** "YYYY-MM". */
  month: string;
  points: number;
  wins?: number;
  losses?: number;
  gamesWon?: number;
  gamesLost?: number;
  played?: number;
  leagueId?: string;
}

export interface BoardLine {
  profileId: string;
  points: number;
  wins: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  gameDiff: number;
  played: number;
  /** Shared on a full tie across every criterion. */
  rank: number;
}

/** Board entries from league points rows (wins and losses from each row's kind; draws count as neither). */
export function boardEntriesFromPoints(
  rows: (LeaguePointsRow & { leagueId?: string })[],
  games?: Map<string, { won: number; lost: number }>,
): BoardEntry[] {
  return rows.map((r) => {
    const g = games?.get(`${r.matchId}|${r.profileId}`);
    return {
      profileId: r.profileId,
      month: r.month,
      points: r.points,
      wins: r.kind === "win" || r.kind === "walkover_win" ? 1 : 0,
      losses: r.kind === "loss" || r.kind === "walkover_loss" ? 1 : 0,
      gamesWon: g?.won ?? 0,
      gamesLost: g?.lost ?? 0,
      played: 1,
      ...(r.leagueId ? { leagueId: r.leagueId } : {}),
    };
  });
}

/** Sums entries per player and ranks them. */
export function rankBoard(entries: BoardEntry[]): BoardLine[] {
  const byPlayer = new Map<string, BoardLine>();
  for (const e of entries) {
    let line = byPlayer.get(e.profileId);
    if (!line) {
      line = { profileId: e.profileId, points: 0, wins: 0, losses: 0, gamesWon: 0, gamesLost: 0, gameDiff: 0, played: 0, rank: 0 };
      byPlayer.set(e.profileId, line);
    }
    line.points += e.points;
    line.wins += e.wins ?? 0;
    line.losses += e.losses ?? 0;
    line.gamesWon += e.gamesWon ?? 0;
    line.gamesLost += e.gamesLost ?? 0;
    line.played += e.played ?? 0;
  }
  const lines = [...byPlayer.values()].map((l) => ({ ...l, gameDiff: l.gamesWon - l.gamesLost }));
  lines.sort(
    (a, b) =>
      b.points - a.points ||
      b.wins - a.wins ||
      b.gameDiff - a.gameDiff ||
      b.gamesWon - a.gamesWon ||
      a.profileId.localeCompare(b.profileId),
  );
  const tied = (a: BoardLine, b: BoardLine) =>
    a.points === b.points && a.wins === b.wins && a.gameDiff === b.gameDiff && a.gamesWon === b.gamesWon;
  lines.forEach((line, i) => {
    line.rank = i > 0 && tied(lines[i - 1], line) ? lines[i - 1].rank : i + 1;
  });
  return lines;
}

export type BoardLength = 1 | 3 | 6 | 9 | 12;
export const BOARD_LENGTHS: readonly BoardLength[] = [1, 3, 6, 9, 12];

function monthIndex(month: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  return Number(m[1]) * 12 + (mm - 1);
}

function monthOf(index: number): string {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

/**
 * The months a board of `length` months covers for the month `at` ("YYYY-MM").
 * `yearStartMonth` 1–12 (1 = January). Empty for an unreadable month.
 */
export function boardMonths(
  at: string,
  length: BoardLength,
  yearStartMonth = 1,
  mode: "block" | "rolling" = "block",
): string[] {
  const idx = monthIndex(at);
  if (idx === null) return [];
  const n = BOARD_LENGTHS.includes(length) ? length : 1;
  let from: number;
  let to: number;
  if (mode === "rolling") {
    from = idx - n + 1;
    to = idx;
  } else {
    const start = Math.min(12, Math.max(1, Math.round(yearStartMonth))) - 1;
    const offset = (((idx % 12) - start) % 12 + 12) % 12;
    const yearStart = idx - offset;
    const blockStart = Math.floor(offset / n) * n;
    from = yearStart + blockStart;
    to = yearStart + Math.min(blockStart + n, 12) - 1;
  }
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(monthOf(i));
  return out;
}

/** One month's board. */
export function monthlyBoard(entries: BoardEntry[], month: string): BoardLine[] {
  return rankBoard(entries.filter((e) => e.month === month));
}

/** A board over several months: the sum of each month's points. */
export function periodBoard(
  entries: BoardEntry[],
  at: string,
  length: BoardLength,
  yearStartMonth = 1,
  mode: "block" | "rolling" = "block",
): BoardLine[] {
  const months = new Set(boardMonths(at, length, yearStartMonth, mode));
  return rankBoard(entries.filter((e) => months.has(e.month)));
}

export interface BoardLeague {
  id: string;
  organizationId: string;
  /** `leagues.counts_toward_top_of_all`. */
  countsTowardTopOfAll: boolean;
}

export type TopScope =
  | { kind: "organization"; organizationId: string }
  /** `optedOut`: organisations with `top_board_opt_out` set. */
  | { kind: "platform"; optedOut: ReadonlySet<string> | string[] };

/**
 * The "top of all leagues" board for a month: every player's total over the
 * leagues that count toward it, in one organisation or across the platform.
 * Entries without a league id, or of a league not listed, are left out.
 */
export function topOfAllLeagues(entries: BoardEntry[], leagues: BoardLeague[], scope: TopScope, month: string): BoardLine[] {
  const optedOut = scope.kind === "platform" ? new Set(scope.optedOut) : new Set<string>();
  const counting = new Set(
    leagues
      .filter((l) => l.countsTowardTopOfAll)
      .filter((l) => (scope.kind === "organization" ? l.organizationId === scope.organizationId : !optedOut.has(l.organizationId)))
      .map((l) => l.id),
  );
  return monthlyBoard(
    entries.filter((e) => e.leagueId !== undefined && counting.has(e.leagueId)),
    month,
  );
}

/** A player's line on a board, or null when they are not on it. */
export function boardLineOf(board: BoardLine[], profileId: string): BoardLine | null {
  return board.find((l) => l.profileId === profileId) ?? null;
}
