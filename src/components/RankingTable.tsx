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

  const medal = (rank: number) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null);

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
                {medal(r.rank) ?? r.rank}
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
