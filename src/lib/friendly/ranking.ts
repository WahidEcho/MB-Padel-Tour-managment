/**
 * Friendly ranking aggregation.
 *
 * Turns raw ledger rows plus per-match player results into ranked lines for a
 * session, a season, or lifetime. Ranking order is locked (DECISIONS.md):
 *   total points -> wins -> game difference -> games won.
 * Players still equal after all four share the same rank (1, 2, 2, 4).
 *
 * Matches played is carried on every line: the scheduler balances court time
 * but cannot always make it exactly equal, and a reader comparing two totals
 * deserves to see that one player had an extra match.
 *
 * Pure module: no database, no framework.
 */

export type LedgerComponent = "base_win" | "fire" | "games";
export type LedgerSource = "friendly" | "tournament";
export type LedgerStatus = "provisional" | "official";

/**
 * How a finished match converts into ranking points (see types.ts RankingModel).
 * Matches always use the padel engine; only the conversion differs.
 */
export type RankingModel = "win_points" | "games_won";

/**
 * Points banked by each player of a finished set-scored match under the
 * "games_won" model: every player takes the games their own side won.
 * A 6-4 set gives the winners 6 each and the losers 4 each.
 */
export function gamesPointsFor(sideGames: number): number {
  return Math.max(0, sideGames);
}

/** One row of `player_score_ledger`, narrowed to what ranking needs. */
export interface LedgerEntry {
  playerProfileId: string;
  matchId: string;
  component: LedgerComponent;
  points: number;
  source: LedgerSource;
  status: LedgerStatus;
  sessionId: string | null;
  seasonId: string | null;
}

/** Per-player match outcome, used for the tiebreaker columns. */
export interface PlayerMatchStat {
  playerProfileId: string;
  matchId: string;
  won: boolean;
  gamesWon: number;
  gamesLost: number;
  sessionId: string | null;
  seasonId: string | null;
}

export interface PlayerRankInput {
  playerProfileId: string;
  basePoints: number;
  firePoints: number;
  /** Points banked under the "games_won" model. Zero in "win_points" sessions. */
  gamePoints: number;
  wins: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  matchesPlayed: number;
  activeStreak?: number;
}

export interface RankedPlayerLine extends PlayerRankInput {
  totalPoints: number;
  gameDiff: number;
  /** Shared on a full tie across every ranking criterion. */
  rank: number;
}

export type RankingScope =
  | { kind: "session"; sessionId: string }
  | { kind: "season"; seasonId: string }
  | { kind: "lifetime" };

export interface AggregateOptions {
  scope: RankingScope;
  /**
   * Only count official rows. Public season and lifetime rankings pass true;
   * the live session page passes false so provisional points show as they land.
   */
  officialOnly: boolean;
  /**
   * Ledger sources to include. Defaults to friendly only — tournament-sourced
   * rows exist in the schema but are not part of friendly rankings unless
   * explicitly switched on.
   */
  sources?: LedgerSource[];
  /** Current streak per player, for display. */
  activeStreaks?: Map<string, number>;
}

function inScope(
  scope: RankingScope,
  sessionId: string | null,
  seasonId: string | null
): boolean {
  switch (scope.kind) {
    case "session":
      return sessionId === scope.sessionId;
    case "season":
      return seasonId === scope.seasonId;
    case "lifetime":
      return true;
  }
}

/**
 * Fold ledger rows and match stats into one input line per player.
 * A player appears if they have either points or a played match in scope, so
 * someone who has only lost still shows up with 0 points.
 */
export function aggregate(
  ledger: LedgerEntry[],
  stats: PlayerMatchStat[],
  opts: AggregateOptions
): PlayerRankInput[] {
  const sources = new Set<LedgerSource>(opts.sources ?? ["friendly"]);
  const rows = new Map<string, PlayerRankInput>();

  const ensure = (id: string): PlayerRankInput => {
    let row = rows.get(id);
    if (!row) {
      row = {
        playerProfileId: id,
        basePoints: 0,
        firePoints: 0,
        gamePoints: 0,
        wins: 0,
        losses: 0,
        gamesWon: 0,
        gamesLost: 0,
        matchesPlayed: 0,
        activeStreak: opts.activeStreaks?.get(id) ?? 0,
      };
      rows.set(id, row);
    }
    return row;
  };

  for (const e of ledger) {
    if (!sources.has(e.source)) continue;
    if (opts.officialOnly && e.status !== "official") continue;
    if (!inScope(opts.scope, e.sessionId, e.seasonId)) continue;
    const row = ensure(e.playerProfileId);
    if (e.component === "fire") row.firePoints += e.points;
    else if (e.component === "games") row.gamePoints += e.points;
    else row.basePoints += e.points;
  }

  for (const s of stats) {
    if (!inScope(opts.scope, s.sessionId, s.seasonId)) continue;
    const row = ensure(s.playerProfileId);
    row.matchesPlayed += 1;
    if (s.won) row.wins += 1;
    else row.losses += 1;
    row.gamesWon += s.gamesWon;
    row.gamesLost += s.gamesLost;
  }

  return [...rows.values()];
}

/**
 * Sort and assign ranks. Ties that survive every criterion share a rank, and
 * the next rank skips accordingly (standard competition ranking).
 */
export function rankPlayers(inputs: PlayerRankInput[]): RankedPlayerLine[] {
  // Both models sum into one total: a session runs one model, so only the
  // relevant components are ever populated. Fire applies to both.
  const lines: RankedPlayerLine[] = inputs.map((i) => ({
    ...i,
    activeStreak: i.activeStreak ?? 0,
    totalPoints: i.basePoints + i.firePoints + i.gamePoints,
    gameDiff: i.gamesWon - i.gamesLost,
    rank: 0,
  }));

  lines.sort(
    (a, b) =>
      b.totalPoints - a.totalPoints ||
      b.wins - a.wins ||
      b.gameDiff - a.gameDiff ||
      b.gamesWon - a.gamesWon ||
      a.playerProfileId.localeCompare(b.playerProfileId)
  );

  const tied = (a: RankedPlayerLine, b: RankedPlayerLine) =>
    a.totalPoints === b.totalPoints &&
    a.wins === b.wins &&
    a.gameDiff === b.gameDiff &&
    a.gamesWon === b.gamesWon;

  lines.forEach((line, i) => {
    line.rank = i > 0 && tied(lines[i - 1], line) ? lines[i - 1].rank : i + 1;
  });

  return lines;
}

/** Convenience: aggregate then rank in one call. */
export function buildRanking(
  ledger: LedgerEntry[],
  stats: PlayerMatchStat[],
  opts: AggregateOptions
): RankedPlayerLine[] {
  return rankPlayers(aggregate(ledger, stats, opts));
}

/** Standings shape the Mexicano scheduler needs, derived from a ranking. */
export function toMexicanoStandings(
  lines: RankedPlayerLine[]
): { playerProfileId: string; points: number; gameDiff: number }[] {
  return lines.map((l) => ({
    playerProfileId: l.playerProfileId,
    points: l.totalPoints,
    gameDiff: l.gameDiff,
  }));
}
