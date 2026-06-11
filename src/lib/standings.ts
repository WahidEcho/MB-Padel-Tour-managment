import type { CompletedSet, Match, MatchSnapshot, Standing } from "./types";

/**
 * Group standings calculation (spec §15).
 * Points: win = 1, loss = 0. Ranking: points, wins, head-to-head (2-way ties),
 * set diff, game diff, games won, team name as final deterministic fallback.
 */

export interface MatchResultInput {
  match: Match;
  snapshot: MatchSnapshot | null;
}

const FINISHED: string[] = ["completed", "walkover", "disqualified", "retired"];

export function isFinished(status: string): boolean {
  return FINISHED.includes(status);
}

function gamesFromSnapshot(snap: MatchSnapshot | null): { a: number; b: number; setsA: number; setsB: number } {
  if (!snap) return { a: 0, b: 0, setsA: 0, setsB: 0 };
  const completed: CompletedSet[] = Array.isArray(snap.completed_sets) ? snap.completed_sets : [];
  let a = 0;
  let b = 0;
  for (const s of completed) {
    a += s.teamAGames ?? 0;
    b += s.teamBGames ?? 0;
  }
  // A force-ended match may have games in the unfinished current set
  const counted = completed.reduce((acc, s) => acc + (s.teamAGames ?? 0) + (s.teamBGames ?? 0), 0);
  const liveGames = (snap.team_a_games ?? 0) + (snap.team_b_games ?? 0);
  if (liveGames > 0 && counted === 0 && completed.length === 0) {
    a += snap.team_a_games;
    b += snap.team_b_games;
  } else if (completed.length > 0 && (snap.team_a_games > 0 || snap.team_b_games > 0)) {
    // games of an in-progress set at force-end time
    const last = completed[completed.length - 1];
    if (last.teamAGames !== snap.team_a_games || last.teamBGames !== snap.team_b_games) {
      a += snap.team_a_games;
      b += snap.team_b_games;
    }
  }
  return { a, b, setsA: snap.team_a_sets ?? 0, setsB: snap.team_b_sets ?? 0 };
}

export function calculateStandings(
  tournamentId: string,
  groupId: string,
  teamIds: string[],
  results: MatchResultInput[],
  disqualifiedTeamIds: Set<string>,
  walkoverGames = 6
): Standing[] {
  const rows = new Map<string, Standing>();
  for (const teamId of teamIds) {
    rows.set(teamId, {
      tournament_id: tournamentId,
      group_id: groupId,
      team_id: teamId,
      rank: 0,
      played: 0,
      won: 0,
      lost: 0,
      points: 0,
      sets_won: 0,
      sets_lost: 0,
      set_diff: 0,
      games_won: 0,
      games_lost: 0,
      game_diff: 0,
      status: disqualifiedTeamIds.has(teamId) ? "disqualified" : "pending",
      manual_status_override: false,
    });
  }

  // head-to-head winner lookup: "loserId|winnerId" pairs
  const h2h = new Map<string, string>();

  for (const { match, snapshot } of results) {
    if (!isFinished(match.status) || !match.team_a_id || !match.team_b_id || !match.winner_team_id) continue;
    const a = rows.get(match.team_a_id);
    const b = rows.get(match.team_b_id);
    if (!a || !b) continue;

    const winnerIsA = match.winner_team_id === match.team_a_id;
    let g = gamesFromSnapshot(snapshot);
    if ((match.status === "walkover" || match.status === "disqualified") && g.a === 0 && g.b === 0) {
      g = winnerIsA
        ? { a: walkoverGames, b: 0, setsA: 1, setsB: 0 }
        : { a: 0, b: walkoverGames, setsA: 0, setsB: 1 };
    }

    a.played += 1;
    b.played += 1;
    a.games_won += g.a;
    a.games_lost += g.b;
    b.games_won += g.b;
    b.games_lost += g.a;
    a.sets_won += g.setsA;
    a.sets_lost += g.setsB;
    b.sets_won += g.setsB;
    b.sets_lost += g.setsA;

    const winner = winnerIsA ? a : b;
    const loser = winnerIsA ? b : a;
    winner.won += 1;
    winner.points += 1;
    loser.lost += 1;
    h2h.set([winner.team_id, loser.team_id].sort().join("|"), winner.team_id);
  }

  for (const row of rows.values()) {
    row.set_diff = row.sets_won - row.sets_lost;
    row.game_diff = row.games_won - row.games_lost;
  }

  const byMetrics = (x: Standing, y: Standing) =>
    y.set_diff - x.set_diff ||
    y.game_diff - x.game_diff ||
    y.games_won - x.games_won ||
    x.team_id.localeCompare(y.team_id);

  const sorted = [...rows.values()].sort(
    (x, y) => y.points - x.points || y.won - x.won || byMetrics(x, y)
  );

  // Head-to-head decides exact two-way ties on points+wins; larger tie groups
  // are non-transitive, so they stay resolved by set/game metrics.
  for (let i = 0; i < sorted.length - 1; i++) {
    const x = sorted[i];
    const y = sorted[i + 1];
    const tiedPair =
      x.points === y.points &&
      x.won === y.won &&
      (i === 0 || sorted[i - 1].points !== x.points || sorted[i - 1].won !== x.won) &&
      (i + 2 >= sorted.length || sorted[i + 2].points !== y.points || sorted[i + 2].won !== y.won);
    if (tiedPair) {
      const winner = h2h.get([x.team_id, y.team_id].sort().join("|"));
      if (winner === y.team_id) {
        sorted[i] = y;
        sorted[i + 1] = x;
      }
    }
  }

  sorted.forEach((row, i) => {
    row.rank = i + 1;
  });
  return sorted;
}

/** Apply qualification statuses once all group matches are finished. */
export function applyQualification(standings: Standing[], qualifyPerGroup: number, groupComplete: boolean): void {
  for (const row of standings) {
    if (row.status === "disqualified") continue;
    if (!groupComplete) {
      row.status = "pending";
    } else {
      row.status = row.rank <= qualifyPerGroup ? "qualified" : "eliminated";
    }
  }
}
