import { getGroups, getStandings, getTeams, getTournament, teamMap } from "@/lib/data";
import SessionRowNotice from "../SessionRowNotice";
import AutoRefresh from "@/components/AutoRefresh";
import StandingsTable from "@/components/StandingsTable";
import QualificationControl from "./QualificationControl";
import { recalcAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [groups, standings, teams, tournament] = await Promise.all([getGroups(id), getStandings(id), getTeams(id), getTournament(id)]);
  if (tournament && tournament.kind !== "tournament") return <SessionRowNotice tournamentId={id} tool="Standings" />;
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

      {/* One table per row until the screen is genuinely wide: eleven columns and
          the override control do not share 550 pixels. */}
      <div className="grid gap-4 2xl:grid-cols-2">
        {groups.map((g) => (
          <div key={g.id} className="card min-w-0 overflow-x-auto">
            <h3 className="mb-2 font-bold">{g.group_name}</h3>
            <StandingsTable
              standings={standings.filter((s) => s.group_id === g.id)}
              teams={tm}
              actions={(s) => (
                <QualificationControl
                  tournamentId={id}
                  teamId={s.team_id}
                  groupId={s.group_id}
                  status={s.status}
                  overridden={s.manual_status_override}
                />
              )}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
