/**
 * Group standings for a team competition, ranked the ITF way. Pure.
 *
 *  1. Ties won.
 *  2. Two nations level: the tie between them.
 *  3. Three or more level: percentage of rubbers won, then of sets won, then of
 *     games won — and the moment a criterion leaves two of them level, the tie
 *     between those two decides.
 *  4. Still level: the seeding, then the name, so the order is always stable.
 *
 * The ITF regulations for 2026 could not be read when this was written; the
 * order is the ITF's standard one for its team competitions. See
 * docs/tennis-junior-finals.md.
 */
import { gamesFromSnapshot, isFinished } from "../standings";
import type { Match, MatchSnapshot, Standing, Tie } from "../types";

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
 * over the two sets a best-of-three is won in.
 */
export function calculateTieStandings(
  tournamentId: string,
  groupId: string,
  teams: TieTeam[],
  ties: Pick<Tie, "id" | "team_a_id" | "team_b_id" | "status" | "winner_team_id">[],
  rubbers: Pick<Match, "id" | "tie_id" | "team_a_id" | "team_b_id" | "status" | "winner_team_id">[],
  snapshots: Map<string, MatchSnapshot>,
  disqualified: Set<string> = new Set(),
  walkoverGames = 6,
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
    if (r.status === "walkover" || (!snap && isFinished(r.status))) {
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
    (t) => pct(t.rubbersWon, t.rubbersLost),
    (t) => pct(t.setsWon, t.setsLost),
    (t) => pct(t.gamesWon, t.gamesLost),
  ];

  /** Orders nations that are level on ties won. */
  const resolve = (ids: string[], level: number): string[] => {
    if (ids.length <= 1) return ids;
    if (ids.length === 2) {
      const w = h2h(ids[0], ids[1]);
      if (w) return w === ids[0] ? ids : [ids[1], ids[0]];
      // Not yet played: fall through to the numbers, then the draw.
    }
    if (level >= criteria.length) return [...ids].sort(byDraw);
    const key = criteria[level];
    const groups = new Map<number, string[]>();
    for (const id of ids) {
      const v = Math.round(key(tally.get(id)!) * 1e9) / 1e9;
      groups.set(v, [...(groups.get(v) ?? []), id]);
    }
    if (groups.size === 1) return resolve(ids, level + 1);
    return [...groups.entries()]
      .sort((x, y) => y[0] - x[0])
      .flatMap(([, members]) => resolve(members, members.length === 2 ? 0 : level + 1));
  };

  const active = teams.map((t) => t.id).filter((id) => !disqualified.has(id));
  const byWins = new Map<number, string[]>();
  for (const id of active) {
    const w = tally.get(id)!.tiesWon;
    byWins.set(w, [...(byWins.get(w) ?? []), id]);
  }
  const order = [...byWins.entries()]
    .sort((x, y) => y[0] - x[0])
    .flatMap(([, ids]) => resolve(ids, 0));
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
