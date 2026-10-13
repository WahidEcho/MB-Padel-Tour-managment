/**
 * From a finished match to league results (Phase 7): who played, what kind of
 * result each player had, and the games for the boards' tie-breaks.
 *
 *   completed / retired / disqualified with a winner   win and loss
 *   completed without a winner (a drawn chess game)     draw for everyone
 *   walkover                                            walkover win and loss
 *   anything not finished                               nothing
 *
 * A player on both sides (a data error) is left out rather than given a win
 * and a loss for one match.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import { leagueResultKind, type LeagueResult } from "./points";

export const FINISHED_FOR_LEAGUE = ["completed", "walkover", "disqualified", "retired"] as const;

export interface LeagueMatchInput {
  id: string;
  status: string | null;
  winner_team_id: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  ended_at?: string | null;
}

export interface SetGames {
  teamAGames?: number | null;
  teamBGames?: number | null;
}

export interface LeagueSnapshotInput {
  completed_sets?: SetGames[] | null;
  team_a_games?: number | null;
  team_b_games?: number | null;
}

/** Games won by each side, from the stored score (completed sets plus an unfinished one). */
export function sideGames(snap: LeagueSnapshotInput | null | undefined): { a: number; b: number } {
  const sets = Array.isArray(snap?.completed_sets) ? snap!.completed_sets! : [];
  let a = 0;
  let b = 0;
  for (const s of sets) {
    a += s.teamAGames ?? 0;
    b += s.teamBGames ?? 0;
  }
  const la = snap?.team_a_games ?? 0;
  const lb = snap?.team_b_games ?? 0;
  if (la + lb > 0) {
    const last = sets[sets.length - 1];
    if (!last || last.teamAGames !== la || last.teamBGames !== lb) {
      a += la;
      b += lb;
    }
  }
  return { a, b };
}

export interface LeagueMatchResults {
  results: LeagueResult[];
  /** By `${matchId}|${profileId}`. */
  games: Map<string, { won: number; lost: number }>;
}

/**
 * The league results of one match for the players on each side, counted on
 * `date` (the night or fixture date). Empty when the match is not finished.
 */
export function leagueResultsOfMatch(
  match: LeagueMatchInput,
  sides: { a: (string | null | undefined)[]; b: (string | null | undefined)[] },
  date: string,
  snapshot?: LeagueSnapshotInput | null,
): LeagueMatchResults {
  const out: LeagueMatchResults = { results: [], games: new Map() };
  if (!(FINISHED_FOR_LEAGUE as readonly string[]).includes(match.status ?? "")) return out;
  const a = [...new Set(sides.a.filter((x): x is string => Boolean(x)))];
  const b = [...new Set(sides.b.filter((x): x is string => Boolean(x)))];
  const both = new Set(a.filter((p) => b.includes(p)));
  const walkover = match.status === "walkover";
  const winner = match.winner_team_id;
  const aWon = winner !== null && winner === match.team_a_id;
  const bWon = winner !== null && winner === match.team_b_id;
  const draw = !walkover && !aWon && !bWon && match.status === "completed";
  if (!aWon && !bWon && !draw) return out; // a finish without a winner that is not a draw: nothing to award
  const g = sideGames(snapshot);
  const add = (profileId: string, onA: boolean) => {
    if (both.has(profileId)) return;
    const won = onA ? aWon : bWon;
    out.results.push({ matchId: match.id, profileId, kind: leagueResultKind({ won, walkover, draw }), date, endedAt: match.ended_at ?? null });
    out.games.set(`${match.id}|${profileId}`, { won: onA ? g.a : g.b, lost: onA ? g.b : g.a });
  };
  for (const p of a) add(p, true);
  for (const p of b) add(p, false);
  return out;
}
