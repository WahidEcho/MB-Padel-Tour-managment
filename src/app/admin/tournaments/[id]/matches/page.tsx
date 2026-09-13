import Link from "next/link";
import { notFound } from "next/navigation";
import { getCourts, getGroups, getMatches, getTeams, getTournament, teamMap } from "@/lib/data";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import MatchStatusBadge from "@/components/MatchStatusBadge";
import { createManualMatch, deleteMatch, regenerateMatches, releaseScoringLock, updateMatchSchedule } from "./actions";
import GroupStageRegenerateForm from "../GroupStageRegenerateForm";
import { NOT_A_TOURNAMENT_MESSAGE, summarizeBrackets } from "@/lib/ops";

export const dynamic = "force-dynamic";

export default async function MatchesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tournament, matches, teams, courts, groups, brackets] = await Promise.all([
    getTournament(id),
    getMatches(id),
    getTeams(id),
    getCourts(id),
    getGroups(id),
    summarizeBrackets(id),
  ]);
  if (!tournament) notFound();
  const isSession = tournament.kind !== "tournament";
  // Regenerating only means something where there is a group stage to rebuild.
  // A chess knockout is seeded from the player list and has no groups.
  const hasGroupStage = !isSession && tournament.sport !== "chess" && groups.length > 0;
  const tm = teamMap(teams);
  const liveCount = matches.filter((m) => ["live", "paused"].includes(m.status)).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">
          Matches ({matches.length}) {liveCount > 0 && <span className="text-success">· {liveCount} live</span>}
        </h2>
        {hasGroupStage && (
          <GroupStageRegenerateForm
            tournamentId={id}
            action={regenerateMatches}
            brackets={brackets}
            label="Regenerate group matches"
            confirmMessage="Regenerate ALL group matches? Existing group match scores will be deleted."
          />
        )}
        {isSession && (
          <p className="max-w-md text-sm text-muted" data-testid="regenerate-session">
            {NOT_A_TOURNAMENT_MESSAGE}
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="text-xs uppercase text-muted">
              <th className="px-2 py-1">#</th>
              <th className="px-2 py-1">Round</th>
              <th className="px-2 py-1">Match</th>
              <th className="px-2 py-1">Court</th>
              <th className="px-2 py-1">Time</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((m) => (
              <tr key={m.id} className="border-t border-border align-middle">
                <td className="px-2 py-2 font-mono text-xs">{m.match_order}</td>
                <td className="px-2 py-2 text-xs">{m.round_name}</td>
                <td className="px-2 py-2 font-semibold">
                  {m.team_a_id ? tm.get(m.team_a_id)?.team_name ?? "?" : "TBD"}{" "}
                  <span className="text-muted">vs</span>{" "}
                  {m.team_b_id ? tm.get(m.team_b_id)?.team_name ?? "?" : "TBD"}
                </td>
                <td className="px-2 py-2">
                  <form action={updateMatchSchedule} className="flex items-center gap-1">
                    <input type="hidden" name="tournament_id" value={id} />
                    <input type="hidden" name="match_id" value={m.id} />
                    <select name="court_id" defaultValue={m.court_id ?? ""} className="input w-26 px-2 py-1 text-xs">
                      <option value="">—</option>
                      {courts.map((c) => (
                        <option key={c.id} value={c.id}>{c.court_name}</option>
                      ))}
                    </select>
                    <input
                      name="match_order"
                      type="number"
                      defaultValue={m.match_order}
                      className="input w-16 px-2 py-1 text-xs"
                      title="Match order"
                    />
                    <input
                      name="scheduled_time"
                      type="datetime-local"
                      defaultValue={m.scheduled_time ? m.scheduled_time.slice(0, 16) : ""}
                      className="input w-44 px-2 py-1 text-xs"
                    />
                    <button className="btn-secondary px-2 py-1 text-xs">Save</button>
                  </form>
                </td>
                <td className="px-2 py-2 text-xs text-muted">
                  {m.scheduled_time ? new Date(m.scheduled_time).toLocaleString() : "order only"}
                </td>
                <td className="px-2 py-2">
                  <MatchStatusBadge status={m.status} />
                  {m.is_pending_sync && <span className="ml-1 badge bg-warning/15 text-warning">pending sync</span>}
                </td>
                <td className="px-2 py-2">
                  <div className="flex items-center gap-1">
                    <Link href={`/referee/matches/${m.id}/score`} className="btn-primary px-2 py-1 text-xs">
                      Score
                    </Link>
                    {m.active_scoring_device_id && (
                      <form action={releaseScoringLock}>
                        <input type="hidden" name="tournament_id" value={id} />
                        <input type="hidden" name="match_id" value={m.id} />
                        <ConfirmSubmit
                          className="btn-secondary px-2 py-1 text-xs"
                          message="Release the scoring lock? Only do this if the original scoring device is gone."
                        >
                          Unlock
                        </ConfirmSubmit>
                      </form>
                    )}
                    <form action={deleteMatch}>
                      <input type="hidden" name="tournament_id" value={id} />
                      <input type="hidden" name="match_id" value={m.id} />
                      <ConfirmSubmit className="px-1 text-xs text-danger" message="Delete this match?">
                        ✕
                      </ConfirmSubmit>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
            {matches.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-8 text-center text-muted">
                  No matches yet. Publish groups to generate the schedule, or add a match manually below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card max-w-2xl space-y-2">
        <h3 className="font-bold">Add match manually</h3>
        <form action={createManualMatch} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <input type="hidden" name="tournament_id" value={id} />
          <select name="team_a_id" required className="input">
            <option value="">Team A…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.team_name}</option>
            ))}
          </select>
          <select name="team_b_id" required className="input">
            <option value="">Team B…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.team_name}</option>
            ))}
          </select>
          <select name="group_id" className="input">
            <option value="">No group (knockout/friendly)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.group_name}</option>
            ))}
          </select>
          <input name="round_name" className="input" placeholder="Round name" />
          <select name="court_id" className="input">
            <option value="">Court…</option>
            {courts.map((c) => (
              <option key={c.id} value={c.id}>{c.court_name}</option>
            ))}
          </select>
          <button className="btn-primary">Add match</button>
        </form>
      </div>
    </div>
  );
}
