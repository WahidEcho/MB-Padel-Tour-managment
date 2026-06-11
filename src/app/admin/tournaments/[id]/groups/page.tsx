import { getGroups, getGroupTeams, getMatches, getTeams } from "@/lib/data";
import { createGroups } from "./actions";
import GroupsClient from "./GroupsClient";

export const dynamic = "force-dynamic";

export default async function GroupsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [teams, groups, groupTeams, matches] = await Promise.all([
    getTeams(id),
    getGroups(id),
    getGroupTeams(id),
    getMatches(id),
  ]);
  const groupMatchCount = matches.filter((m) => m.stage === "group").length;
  const finishedCount = matches.filter(
    (m) => m.stage === "group" && !["scheduled", "ready"].includes(m.status)
  ).length;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-3">
        <form action={createGroups} className="flex items-end gap-2">
          <input type="hidden" name="tournament_id" value={id} />
          <div>
            <label className="label">Number of groups</label>
            <input
              name="group_count"
              type="number"
              min={1}
              max={26}
              defaultValue={Math.max(1, Math.round(teams.length / 3)) || 2}
              className="input w-28"
            />
          </div>
          <button
            className="btn-primary"
            type="submit"
            disabled={teams.length < 2}
            title={teams.length < 2 ? "Add teams first" : undefined}
          >
            {groups.length > 0 ? "Recreate groups + random draw" : "Create groups + random draw"}
          </button>
        </form>
        <p className="text-xs text-muted">
          {teams.length} teams. Teams are distributed as evenly as possible (e.g. 10 teams in 3 groups → 4/3/3).
          {groups.length > 0 && groupMatchCount > 0 && (
            <span className="block font-semibold text-warning">
              ⚠ Recreating or re-drawing groups will regenerate group matches.
              {finishedCount > 0 && ` ${finishedCount} match(es) already played will be lost.`}
            </span>
          )}
        </p>
      </div>

      {groups.length > 0 && (
        <GroupsClient
          tournamentId={id}
          groups={groups}
          groupTeams={groupTeams}
          teams={teams.map((t) => ({
            id: t.id,
            team_name: t.team_name,
            players: t.players?.map((p) => p.full_name).join(" & ") ?? "",
          }))}
          published={groups.every((g) => g.status === "published")}
          hasMatches={groupMatchCount > 0}
        />
      )}
    </div>
  );
}
