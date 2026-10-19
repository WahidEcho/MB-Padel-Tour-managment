import Link from "next/link";
import { notFound } from "next/navigation";
import { requireEntityPage } from "@/lib/guard";
import { getMatch } from "@/lib/data";
import { loadMatchLog } from "@/lib/scoring/matchLogServer";
import { MatchLogList } from "@/app/referee/matches/[matchId]/score/V2";

export const dynamic = "force-dynamic";

/**
 * Scoring v2: a match's log for the organiser — every point with the score after it,
 * aces, faults, lets, violations, timers and breaks, rulings, walkover or retirement,
 * with when and who entered each one. Admins and managers always see it.
 */
export default async function MatchLogPage({ params }: { params: Promise<{ id: string; matchId: string }> }) {
  const { id, matchId } = await params;
  await requireEntityPage({ match: matchId }, ["admin", "manager"], `/admin/tournaments/${id}/matches/${matchId}/log`);
  const match = await getMatch(matchId);
  if (!match || match.tournament_id !== id) notFound();
  const log = await loadMatchLog(matchId);
  if (!log) notFound();
  return (
    <div className="space-y-3" data-testid="admin-match-log">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold">Match log</h2>
          <p className="text-sm text-muted">
            {log.sides.A} vs {log.sides.B} · {match.round_name} · newest first
          </p>
        </div>
        <Link href={`/admin/tournaments/${id}/matches`} className="btn-secondary text-xs">
          ← Matches
        </Link>
      </div>
      <div className="card">
        <MatchLogList entries={log.entries} />
      </div>
    </div>
  );
}
