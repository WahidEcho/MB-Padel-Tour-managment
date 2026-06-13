import { getGroups, getStandings, getTeams, teamMap } from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import StandingsTable from "@/components/StandingsTable";
import { overrideQualification, recalcAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [groups, standings, teams] = await Promise.all([getGroups(id), getStandings(id), getTeams(id)]);
  const tm = teamMap(teams);

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={15} />
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Leaderboard</h2>
        <form action={recalcAction}>
          <input type="hidden" name="tournament_id" value={id} />
          <button className="btn-secondary text-xs">Recalculate now</button>
        </form>
      </div>
      <p className="text-xs text-muted">
        Win = 1 point. Ranking: points → wins → head-to-head → set diff → game diff → games won.
        Use the status dropdown for a manual qualification override (* = overridden, logged in audit trail).
      </p>

      {groups.length === 0 && <p className="card p-8 text-center text-muted">Create and publish groups first.</p>}

      <div className="grid gap-4 xl:grid-cols-2">
        {groups.map((g) => (
          <div key={g.id} className="card overflow-x-auto">
            <h3 className="mb-2 font-bold">{g.group_name}</h3>
            <StandingsTable
              standings={standings.filter((s) => s.group_id === g.id)}
              teams={tm}
              actions={(s) => (
                <form action={overrideQualification} className="flex items-center gap-1">
                  <input type="hidden" name="tournament_id" value={id} />
                  <input type="hidden" name="standing_id" value={s.id} />
                  <select name="status" defaultValue={s.status} className="input w-auto px-2 py-1 text-xs">
                    {["pending", "qualified", "eliminated", "disqualified"].map((st) => (
                      <option key={st} value={st}>{st}</option>
                    ))}
                  </select>
                  <button className="btn-secondary px-2 py-1 text-xs">Set</button>
                  {s.manual_status_override && (
                    <button name="reset" value="1" className="px-1 text-xs text-muted hover:text-foreground" title="Clear override">
                      ↺
                    </button>
                  )}
                </form>
              )}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
