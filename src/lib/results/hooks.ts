/**
 * What happens elsewhere when a result is made or unmade (Phase 7).
 *
 *   onMatchFinalized   from finalizeMatch (src/lib/ops.ts) for tournament
 *                      matches, rubbers and knockouts, and from
 *                      applyFriendlyResult for a session's matches
 *   onMatchReopened    from every path that takes a result back: an Undo past
 *                      the end (src/lib/scoring/append.ts), a correction of a
 *                      finished friendly match (revertFriendlyResult first, then
 *                      the new result finalises), and a tournament's live-data
 *                      reset or a deleted match (onTournamentReset)
 *
 * Today the only listener is league points (src/lib/leagues/server.ts): the
 * leagues a match counts in are recomputed from their results as they stand, so
 * a result counts exactly once and an undo leaves nothing behind. A failure is
 * logged, never thrown into the scoring path (Admin → League → Recalculate
 * repairs it).
 *
 * Server-only.
 */
interface MatchRef {
  id: string;
  tournament_id: string;
}

export async function onMatchFinalized(match: MatchRef): Promise<void> {
  const { recomputeLeaguesForMatch } = await import("../leagues/server");
  await recomputeLeaguesForMatch(match);
}

export async function onMatchReopened(match: MatchRef): Promise<void> {
  const { recomputeLeaguesForMatch } = await import("../leagues/server");
  await recomputeLeaguesForMatch(match);
}

/** A tournament's results were wiped or a match deleted: the league it counts toward is recomputed. */
export async function onTournamentReset(tournamentId: string): Promise<void> {
  const { recomputeLeaguesForTournament } = await import("../leagues/server");
  await recomputeLeaguesForTournament(tournamentId);
}
