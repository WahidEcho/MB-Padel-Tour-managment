import type { FriendlyRankingSnapshot, PublicPlayer } from "@/lib/types";

/**
 * Shared ranking table. Shows only public data — names and ranking numbers.
 * Mobile numbers must never reach this component.
 */
export default function RankingTable({
  rows,
  names,
  compact = false,
}: {
  rows: FriendlyRankingSnapshot[];
  names: Map<string, PublicPlayer>;
  compact?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="card p-6 text-center text-muted">No results yet.</p>;
  }

  /**
   * Medals follow podium position, not rank number.
   *
   * Shared ranks skip numbers — four players tied at the top rank 1,1,3,3 — so
   * mapping medals straight off the rank gave two golds and two bronzes with no
   * silver, which reads like a bug. Ranking the *distinct* point totals instead
   * means the medal always answers "which podium step is this", and everyone on
   * the same step gets the same medal.
   */
  const podium = [...new Set(rows.map((r) => r.rank))].sort((a, b) => a - b);
  const medal = (rank: number) => {
    const step = podium.indexOf(rank);
    return step === 0 ? "🥇" : step === 1 ? "🥈" : step === 2 ? "🥉" : null;
  };

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-muted">
            <th className="py-1">#</th>
            <th className="py-1">Player</th>
            <th className="py-1 text-right">Pts</th>
            <th className="py-1 text-right">P</th>
            {!compact && (
              <>
                <th className="py-1 text-right">W</th>
                <th className="py-1 text-right">L</th>
                <th className="py-1 text-right">🔥</th>
                <th className="py-1 text-right">Diff</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.scope}-${r.player_profile_id}`} className="border-t border-border">
              <td className="py-1.5 font-bold">
                {/* Medal and number together: the medal shows the podium step,
                    the number is still the real (possibly shared) rank. */}
                <span className="flex items-center gap-1">
                  {medal(r.rank) && <span aria-hidden>{medal(r.rank)}</span>}
                  <span className={medal(r.rank) ? "text-xs text-muted" : ""}>{r.rank}</span>
                </span>
              </td>
              <td className="py-1.5">
                {names.get(r.player_profile_id)?.public_name ?? "—"}
                {r.active_streak >= 2 && (
                  <span className="badge ml-1 bg-accent/15 text-accent">🔥 {r.active_streak}</span>
                )}
              </td>
              <td className="py-1.5 text-right font-bold">{r.points}</td>
              <td className="py-1.5 text-right text-muted">{r.matches_played}</td>
              {!compact && (
                <>
                  <td className="py-1.5 text-right text-muted">{r.wins}</td>
                  <td className="py-1.5 text-right text-muted">{r.losses}</td>
                  <td className="py-1.5 text-right text-muted">{r.fire_points}</td>
                  <td className="py-1.5 text-right text-muted">
                    {r.game_diff > 0 ? `+${r.game_diff}` : r.game_diff}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
