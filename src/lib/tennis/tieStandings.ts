/**
 * Group standings for a team competition, ranked by Reg 38 of the 2026 ITF
 * Junior Team Competitions regulations. Pure.
 *
 *  1. Points: one per tie won.
 *  2. Two nations level on points: the tie between them.
 *  3. Three or more level on points: matches (rubbers) won, then the percentage
 *     of sets won, then of games won, over all their group rubbers. Head-to-head
 *     is never used here, even when a criterion leaves two of them level.
 *  4. Still level: the seeding, then the name, so the order is always stable
 *     (the Referee decides a true dead heat).
 *
 * Counting (Reg 38): a match tie-break is one set and one game; a rubber stopped
 * by injury counts its full score (6-1 2-0 ret. is 6-1 6-0); a walkover counts
 * 6-0 6-0.
 */
import { gamesFromSnapshot, isFinished } from "../standings";
import type { CompletedSet, Match, MatchSnapshot, Standing, Tie } from "../types";

/** What finishing a stopped rubber's score needs from its rules. */
export interface FinishRules {
  setsToWinMatch: number;
  gamesToWinSet: number;
  /** The deciding set is a match tie-break (doubles, the shortened singles). */
  matchTiebreak?: boolean;
}

const TENNIS_SINGLES: FinishRules = { setsToWinMatch: 2, gamesToWinSet: 6 };

/**
 * A rubber stopped by retirement (or a default) scored as if the winner had won
 * every remaining game (Reg 38): the set in progress is completed for them, and
 * any set still needed is won to love — a match tie-break as one game. Sets are
 * from side A's view; `winner` is the side that won the rubber.
 */
export function fullScore(
  completed: CompletedSet[],
  current: { a: number; b: number },
  winner: "A" | "B",
  rules: FinishRules,
): { a: number; b: number; setsA: number; setsB: number } {
  const sets = completed.map((s) => [s.teamAGames ?? 0, s.teamBGames ?? 0] as [number, number]);
  const won = (side: 0 | 1) => sets.filter((s) => s[side] > s[1 - side]).length;
  const w = winner === "A" ? 0 : 1;
  const need = rules.setsToWinMatch;
  const decider = () => rules.matchTiebreak && won(0) === need - 1 && won(1) === need - 1;
  // The set in progress, when it has a game in it.
  if (current.a + current.b > 0 && won(w) < need) {
    const g: [number, number] = [current.a, current.b];
    if (decider()) {
      g[w] = 1;
      g[1 - w] = 0;
    } else {
      const other = g[1 - w];
      g[w] = other >= rules.gamesToWinSet - 1 ? rules.gamesToWinSet + 1 : rules.gamesToWinSet;
    }
    sets.push(g);
  }
  while (won(w) < need) {
    const g: [number, number] = [0, 0];
    g[w] = decider() ? 1 : rules.gamesToWinSet;
    sets.push(g);
  }
  return {
    a: sets.reduce((n, s) => n + s[0], 0),
    b: sets.reduce((n, s) => n + s[1], 0),
    setsA: won(0),
    setsB: won(1),
  };
}

export interface TieTeam {
  id: string;
  seed_number: number | null;
  team_name: string;
}

interface Tally {
  teamId: string;
  tiesPlayed: number;
  tiesWon: number;
  tiesLost: number;
  rubbersWon: number;
  rubbersLost: number;
  setsWon: number;
  setsLost: number;
  gamesWon: number;
  gamesLost: number;
}

const pct = (won: number, lost: number) => (won + lost === 0 ? 0 : won / (won + lost));

/**
 * `walkoverGames` is what a walked-over rubber counts as per set (6 for 6-0),
 * over the two sets a best-of-three is won in. `rulesFor` gives a rubber's
 * rules, for finishing a retired rubber's score; best of three by default.
 */
export function calculateTieStandings(
  tournamentId: string,
  groupId: string,
  teams: TieTeam[],
  ties: Pick<Tie, "id" | "team_a_id" | "team_b_id" | "status" | "winner_team_id">[],
  rubbers: (Pick<Match, "id" | "tie_id" | "team_a_id" | "team_b_id" | "status" | "winner_team_id"> & Partial<Pick<Match, "rubber_type">>)[],
  snapshots: Map<string, MatchSnapshot>,
  disqualified: Set<string> = new Set(),
  walkoverGames = 6,
  rulesFor: (rubber: Pick<Match, "id" | "rubber_type">) => FinishRules = () => TENNIS_SINGLES,
): Standing[] {
  const tally = new Map<string, Tally>(
    teams.map((t) => [
      t.id,
      { teamId: t.id, tiesPlayed: 0, tiesWon: 0, tiesLost: 0, rubbersWon: 0, rubbersLost: 0, setsWon: 0, setsLost: 0, gamesWon: 0, gamesLost: 0 },
    ]),
  );
  const tieIds = new Set(ties.map((t) => t.id));

  for (const t of ties) {
    if (t.status !== "completed" || !t.winner_team_id || !t.team_a_id || !t.team_b_id) continue;
    const a = tally.get(t.team_a_id);
    const b = tally.get(t.team_b_id);
    if (!a || !b) continue;
    a.tiesPlayed++;
    b.tiesPlayed++;
    if (t.winner_team_id === t.team_a_id) {
      a.tiesWon++;
      b.tiesLost++;
    } else {
      b.tiesWon++;
      a.tiesLost++;
    }
  }

  for (const r of rubbers) {
    if (!r.tie_id || !tieIds.has(r.tie_id) || !isFinished(r.status) || !r.winner_team_id) continue;
    const a = r.team_a_id ? tally.get(r.team_a_id) : undefined;
    const b = r.team_b_id ? tally.get(r.team_b_id) : undefined;
    if (!a || !b) continue;
    const aWon = r.winner_team_id === r.team_a_id;
    (aWon ? a : b).rubbersWon++;
    (aWon ? b : a).rubbersLost++;
    const snap = snapshots.get(r.id) ?? null;
    let g = gamesFromSnapshot(snap);
    if ((r.status === "retired" || r.status === "disqualified") && snap) {
      const done = Array.isArray(snap.completed_sets) ? snap.completed_sets : [];
      // The live games are the set in progress unless they repeat the last finished set.
      const last = done[done.length - 1];
      const repeat = last && last.teamAGames === snap.team_a_games && last.teamBGames === snap.team_b_games;
      const current = repeat ? { a: 0, b: 0 } : { a: snap.team_a_games ?? 0, b: snap.team_b_games ?? 0 };
      g = fullScore(done, current, aWon ? "A" : "B", rulesFor(r));
    } else if (r.status === "walkover" || (!snap && isFinished(r.status))) {
      g = aWon
        ? { a: walkoverGames * 2, b: 0, setsA: 2, setsB: 0 }
        : { a: 0, b: walkoverGames * 2, setsA: 0, setsB: 2 };
    }
    a.setsWon += g.setsA;
    a.setsLost += g.setsB;
    b.setsWon += g.setsB;
    b.setsLost += g.setsA;
    a.gamesWon += g.a;
    a.gamesLost += g.b;
    b.gamesWon += g.b;
    b.gamesLost += g.a;
  }

  // Head to head: who won the tie between two nations, if they have played it.
  const h2h = (x: string, y: string): string | null => {
    const t = ties.find(
      (tt) =>
        tt.status === "completed" &&
        ((tt.team_a_id === x && tt.team_b_id === y) || (tt.team_a_id === y && tt.team_b_id === x)),
    );
    return t?.winner_team_id ?? null;
  };
  const seedOf = new Map(teams.map((t) => [t.id, t]));
  const byDraw = (x: string, y: string) => {
    const sx = seedOf.get(x)?.seed_number ?? Number.MAX_SAFE_INTEGER;
    const sy = seedOf.get(y)?.seed_number ?? Number.MAX_SAFE_INTEGER;
    if (sx !== sy) return sx - sy;
    return (seedOf.get(x)?.team_name ?? "").localeCompare(seedOf.get(y)?.team_name ?? "");
  };
  const criteria: ((t: Tally) => number)[] = [
    (t) => t.rubbersWon,
    (t) => pct(t.setsWon, t.setsLost),
    (t) => pct(t.gamesWon, t.gamesLost),
  ];

  /** Orders three or more nations level on points, by the numbers alone. */
  const byNumbers = (ids: string[], level: number): string[] => {
    if (ids.length <= 1) return ids;
    if (level >= criteria.length) return [...ids].sort(byDraw);
    const key = criteria[level];
    const groups = new Map<number, string[]>();
    for (const id of ids) {
      const v = Math.round(key(tally.get(id)!) * 1e9) / 1e9;
      groups.set(v, [...(groups.get(v) ?? []), id]);
    }
    return [...groups.entries()]
      .sort((x, y) => y[0] - x[0])
      .flatMap(([, members]) => byNumbers(members, level + 1));
  };

  /** Orders nations level on points: two by their tie, three or more by the numbers. */
  const resolve = (ids: string[]): string[] => {
    if (ids.length === 2) {
      const w = h2h(ids[0], ids[1]);
      if (w) return w === ids[0] ? ids : [ids[1], ids[0]];
      // Not yet played: the numbers, then the draw.
    }
    return byNumbers(ids, 0);
  };

  const active = teams.map((t) => t.id).filter((id) => !disqualified.has(id));
  const byWins = new Map<number, string[]>();
  for (const id of active) {
    const w = tally.get(id)!.tiesWon;
    byWins.set(w, [...(byWins.get(w) ?? []), id]);
  }
  const order = [...byWins.entries()]
    .sort((x, y) => y[0] - x[0])
    .flatMap(([, ids]) => resolve(ids));
  const dq = teams.map((t) => t.id).filter((id) => disqualified.has(id));

  return [...order, ...dq].map((id, i) => {
    const t = tally.get(id)!;
    return {
      tournament_id: tournamentId,
      group_id: groupId,
      team_id: id,
      rank: i + 1,
      played: t.tiesPlayed,
      won: t.tiesWon,
      lost: t.tiesLost,
      points: t.tiesWon,
      rubbers_won: t.rubbersWon,
      rubbers_lost: t.rubbersLost,
      sets_won: t.setsWon,
      sets_lost: t.setsLost,
      set_diff: t.setsWon - t.setsLost,
      games_won: t.gamesWon,
      games_lost: t.gamesLost,
      game_diff: t.gamesWon - t.gamesLost,
      status: disqualified.has(id) ? "disqualified" : "pending",
      manual_status_override: false,
    } as Standing;
  });
}
