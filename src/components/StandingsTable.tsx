import Avatar from "./Avatar";
import type { Standing, Team } from "@/lib/types";

const STATUS_BADGE: Record<string, string> = {
  qualified: "bg-success/15 text-success",
  pending: "bg-border text-muted",
  eliminated: "bg-danger/10 text-muted",
  disqualified: "bg-danger/15 text-danger",
};

export default function StandingsTable({
  standings,
  teams,
  compact = false,
  actions,
}: {
  standings: Standing[];
  teams: Map<string, Team>;
  compact?: boolean;
  actions?: (s: Standing) => React.ReactNode;
}) {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="text-xs uppercase text-muted">
          <th className="px-2 py-1">#</th>
          <th className="px-2 py-1">Team</th>
          <th className="px-2 py-1 text-center">P</th>
          <th className="px-2 py-1 text-center">W</th>
          <th className="px-2 py-1 text-center">L</th>
          <th className="px-2 py-1 text-center">Pts</th>
          {!compact && (
            <>
              <th className="px-2 py-1 text-center" title="Sets won-lost">Sets</th>
              <th className="px-2 py-1 text-center" title="Set difference">SD</th>
              <th className="px-2 py-1 text-center" title="Games won-lost">Games</th>
              <th className="px-2 py-1 text-center" title="Game difference">GD</th>
            </>
          )}
          <th className="px-2 py-1">Status</th>
          {actions && <th className="px-2 py-1" />}
        </tr>
      </thead>
      <tbody>
        {standings.map((s) => {
          const team = teams.get(s.team_id);
          return (
            <tr
              key={s.team_id}
              className={`border-t border-border ${s.status === "qualified" ? "bg-success/5" : ""}`}
            >
              <td className="px-2 py-1.5 font-bold">{s.rank}</td>
              <td className="px-2 py-1.5">
                <div className="flex items-center gap-2">
                  {!compact && (
                    <div className="flex -space-x-1.5">
                      {team?.players?.map((p) => (
                        <Avatar key={p.id} name={p.full_name} photoUrl={p.photo_url} size={24} />
                      ))}
                    </div>
                  )}
                  <div>
                    <p className="font-semibold leading-tight">{team?.team_name ?? "?"}</p>
                    {!compact && (
                      <p className="text-xs leading-tight text-muted">
                        {team?.players?.map((p) => p.full_name).join(" & ")}
                      </p>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-2 py-1.5 text-center">{s.played}</td>
              <td className="px-2 py-1.5 text-center">{s.won}</td>
              <td className="px-2 py-1.5 text-center">{s.lost}</td>
              <td className="px-2 py-1.5 text-center font-bold">{s.points}</td>
              {!compact && (
                <>
                  <td className="px-2 py-1.5 text-center">{s.sets_won}-{s.sets_lost}</td>
                  <td className="px-2 py-1.5 text-center">{s.set_diff > 0 ? `+${s.set_diff}` : s.set_diff}</td>
                  <td className="px-2 py-1.5 text-center">{s.games_won}-{s.games_lost}</td>
                  <td className="px-2 py-1.5 text-center">{s.game_diff > 0 ? `+${s.game_diff}` : s.game_diff}</td>
                </>
              )}
              <td className="px-2 py-1.5">
                <span className={`badge ${STATUS_BADGE[s.status]}`}>
                  {s.status}
                  {s.manual_status_override ? " *" : ""}
                </span>
              </td>
              {actions && <td className="px-2 py-1.5">{actions(s)}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
