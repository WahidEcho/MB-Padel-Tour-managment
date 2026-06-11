import Link from "next/link";
import { getTeams } from "@/lib/data";
import Avatar from "@/components/Avatar";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { addTeam, deleteTeam, setCheckIn, setTeamStatus, updateTeam } from "./actions";

export const dynamic = "force-dynamic";

const CHECKIN_LABEL: Record<string, [string, string]> = {
  not_arrived: ["Not arrived", "bg-border text-muted"],
  checked_in: ["Checked in", "bg-success/15 text-success"],
  no_show: ["No-show", "bg-warning/15 text-warning"],
  disqualified: ["Disqualified", "bg-danger/15 text-danger"],
};

export default async function TeamsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const teams = await getTeams(id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Teams ({teams.length})</h2>
        <div className="flex gap-2">
          <a href="/api/csv-template" className="btn-secondary text-xs">Download CSV template</a>
          <Link href={`/admin/tournaments/${id}/teams/import`} className="btn-secondary text-xs">
            Import CSV
          </Link>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {teams.map((team) => {
          const [checkinLabel, checkinClass] = CHECKIN_LABEL[team.check_in_status] ?? CHECKIN_LABEL.not_arrived;
          return (
            <div key={team.id} className="card space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <div className="flex -space-x-2">
                    {team.players?.map((p) => (
                      <Avatar key={p.id} name={p.full_name} photoUrl={p.photo_url} size={40} />
                    ))}
                  </div>
                  <div>
                    <p className="font-bold">{team.team_name}</p>
                    <p className="text-xs text-muted">
                      {team.players?.map((p) => p.full_name).join(" & ")}
                      {team.phone ? ` · ${team.phone}` : ""}
                    </p>
                  </div>
                </div>
                <span className={`badge ${checkinClass}`}>{checkinLabel}</span>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {team.check_in_status !== "checked_in" && team.team_status === "active" && (
                  <form action={setCheckIn}>
                    <input type="hidden" name="tournament_id" value={id} />
                    <input type="hidden" name="team_id" value={team.id} />
                    <input type="hidden" name="status" value="checked_in" />
                    <button className="btn-primary px-3 py-1 text-xs">Check in</button>
                  </form>
                )}
                {team.check_in_status === "checked_in" && (
                  <form action={setCheckIn}>
                    <input type="hidden" name="tournament_id" value={id} />
                    <input type="hidden" name="team_id" value={team.id} />
                    <input type="hidden" name="status" value="not_arrived" />
                    <button className="btn-secondary px-3 py-1 text-xs">Undo check-in</button>
                  </form>
                )}
                {team.team_status === "active" && team.check_in_status !== "no_show" && (
                  <form action={setCheckIn}>
                    <input type="hidden" name="tournament_id" value={id} />
                    <input type="hidden" name="team_id" value={team.id} />
                    <input type="hidden" name="status" value="no_show" />
                    <button className="btn-secondary px-3 py-1 text-xs">No-show</button>
                  </form>
                )}
                {team.team_status === "active" ? (
                  <form action={setTeamStatus}>
                    <input type="hidden" name="tournament_id" value={id} />
                    <input type="hidden" name="team_id" value={team.id} />
                    <input type="hidden" name="status" value="disqualified" />
                    <ConfirmSubmit
                      className="btn-secondary px-3 py-1 text-xs text-danger"
                      message={`Disqualify ${team.team_name}? Future matches become walkovers. You can restore the team later.`}
                    >
                      Disqualify
                    </ConfirmSubmit>
                  </form>
                ) : (
                  <form action={setTeamStatus}>
                    <input type="hidden" name="tournament_id" value={id} />
                    <input type="hidden" name="team_id" value={team.id} />
                    <input type="hidden" name="status" value="active" />
                    <ConfirmSubmit className="btn-secondary px-3 py-1 text-xs" message={`Restore ${team.team_name}?`}>
                      Restore team
                    </ConfirmSubmit>
                  </form>
                )}
                <form action={deleteTeam}>
                  <input type="hidden" name="tournament_id" value={id} />
                  <input type="hidden" name="team_id" value={team.id} />
                  <ConfirmSubmit
                    className="btn-secondary px-3 py-1 text-xs text-danger"
                    message={`Delete ${team.team_name} permanently?`}
                  >
                    Delete
                  </ConfirmSubmit>
                </form>
              </div>

              <details>
                <summary className="cursor-pointer text-xs font-semibold text-muted">Edit team</summary>
                <form action={updateTeam} className="mt-2 space-y-2">
                  <input type="hidden" name="tournament_id" value={id} />
                  <input type="hidden" name="team_id" value={team.id} />
                  <input name="team_name" defaultValue={team.team_name} className="input" placeholder="Team name" />
                  <div className="grid grid-cols-2 gap-2">
                    <input name="player_1_name" defaultValue={team.players?.[0]?.full_name} className="input" placeholder="Player 1" />
                    <input name="player_2_name" defaultValue={team.players?.[1]?.full_name} className="input" placeholder="Player 2" />
                    <div>
                      <label className="label">P1 photo</label>
                      <input type="file" name="player_1_photo" accept="image/*" className="input text-xs" />
                    </div>
                    <div>
                      <label className="label">P2 photo</label>
                      <input type="file" name="player_2_photo" accept="image/*" className="input text-xs" />
                    </div>
                  </div>
                  <input name="phone" defaultValue={team.phone ?? ""} className="input" placeholder="Phone" />
                  <input name="notes" defaultValue={team.notes ?? ""} className="input" placeholder="Notes" />
                  <button className="btn-primary px-3 py-1 text-xs">Save changes</button>
                </form>
              </details>
            </div>
          );
        })}
      </div>

      <div className="card max-w-xl space-y-3 p-5">
        <h3 className="font-bold">Add team manually</h3>
        <form action={addTeam} className="space-y-2">
          <input type="hidden" name="tournament_id" value={id} />
          <input name="team_name" required className="input" placeholder="Team name *" />
          <div className="grid grid-cols-2 gap-2">
            <input name="player_1_name" required className="input" placeholder="Player 1 name *" />
            <input name="player_2_name" required className="input" placeholder="Player 2 name *" />
            <div>
              <label className="label">Player 1 photo (optional)</label>
              <input type="file" name="player_1_photo" accept="image/*" className="input text-xs" />
            </div>
            <div>
              <label className="label">Player 2 photo (optional)</label>
              <input type="file" name="player_2_photo" accept="image/*" className="input text-xs" />
            </div>
          </div>
          <input name="phone" className="input" placeholder="Phone (optional)" />
          <input name="notes" className="input" placeholder="Internal notes (optional)" />
          <button className="btn-primary">Save Team</button>
        </form>
      </div>
    </div>
  );
}
