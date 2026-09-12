"use client";

import { useMemo, useState } from "react";
import Avatar from "@/components/Avatar";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import PlayerPhotoField from "@/components/PlayerPhotoField";
import type { Team } from "@/lib/types";
import { addTeam, deleteTeam, setCheckIn, setTeamStatus, updateTeam } from "./actions";

const CHECKIN_LABEL: Record<string, [string, string]> = {
  not_arrived: ["Not arrived", "bg-border text-muted"],
  checked_in: ["Checked in", "bg-success/15 text-success"],
  no_show: ["No-show", "bg-warning/15 text-warning"],
  disqualified: ["Disqualified", "bg-danger/15 text-danger"],
};

const NEW = "__new__";

function hasPhoto(team: Team): boolean {
  return (team.players ?? []).every((p) => Boolean(p.photo_url || p.portrait_url));
}

function playerNames(team: Team): string {
  return (team.players ?? []).map((p) => p.full_name).join(" & ");
}

/**
 * Roster on the left, one editor on the right.
 *
 * Modelled on the reference app's players screen: the list is the overview —
 * who is entered, who has checked in, whose photo is still missing — and the
 * detail pane is where one entry is changed, so there is never more than one
 * open form to lose track of.
 */
export default function TeamsClient({
  tournamentId,
  teams,
  isChess,
}: {
  tournamentId: string;
  teams: Team[];
  isChess: boolean;
}) {
  const noun = isChess ? "player" : "team";
  const [selectedId, setSelectedId] = useState<string>(teams[0]?.id ?? NEW);
  const [query, setQuery] = useState("");

  const missingPhotos = useMemo(
    () => teams.filter((t) => t.team_status === "active" && !hasPhoto(t)).length,
    [teams],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter(
      (t) => t.team_name.toLowerCase().includes(q) || playerNames(t).toLowerCase().includes(q),
    );
  }, [teams, query]);

  const selected = teams.find((t) => t.id === selectedId) ?? null;
  const adding = selectedId === NEW || !selected;

  return (
    <div className="space-y-3">
      {missingPhotos > 0 && (
        <p className="rounded-xl bg-warning/10 px-3 py-2 text-xs font-semibold text-warning">
          {missingPhotos} {missingPhotos === 1 ? `${noun} has` : `${noun}s have`} no photo yet. The
          venue screen shows initials instead of a face until one is added.
        </p>
      )}

      <div className="grid gap-3 xl:grid-cols-[20rem_minmax(0,1fr)]">
        {/* ---------------- Roster ---------------- */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${noun}s`}
              className="input text-sm"
            />
            <button type="button" className="btn-primary shrink-0 px-3 text-xs" onClick={() => setSelectedId(NEW)}>
              + Add
            </button>
          </div>

          <ul className="max-h-[32rem] space-y-1 overflow-y-auto pr-1">
            {shown.map((t) => {
              const [label, cls] = CHECKIN_LABEL[t.check_in_status] ?? CHECKIN_LABEL.not_arrived;
              const photos = hasPhoto(t);
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    className={`flex w-full items-center gap-2 rounded-xl border px-2 py-1.5 text-left transition-colors ${
                      t.id === selectedId ? "border-accent bg-accent/10" : "border-border hover:bg-card"
                    }`}
                  >
                    <span className="flex -space-x-2">
                      {(t.players ?? []).map((p) => (
                        <Avatar key={p.id} name={p.full_name} person={p} size={28} />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold">{t.team_name}</span>
                      <span className="block truncate text-[11px] text-muted">
                        {photos ? "Photo set" : "No photo"}
                        {t.team_status !== "active" ? ` · ${t.team_status}` : ""}
                      </span>
                    </span>
                    <span className={`badge shrink-0 text-[10px] ${cls}`}>{label}</span>
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && (
              <li className="px-2 py-6 text-center text-xs text-muted">
                {teams.length === 0 ? `No ${noun}s yet.` : "Nothing matches that search."}
              </li>
            )}
          </ul>
        </div>

        {/* ---------------- Editor ---------------- */}
        <div className="card space-y-3">
          {adding ? (
            <>
              <h3 className="font-bold">Add {noun}</h3>
              <form action={addTeam} className="space-y-3" key="add">
                <input type="hidden" name="tournament_id" value={tournamentId} />
                <div>
                  <label className="label">{isChess ? "Player name" : "Team name"} *</label>
                  <input name="team_name" required className="input" />
                </div>
                {isChess ? (
                  <PlayerPhotoField name="player_1" folder="tournament-player" label="Photo" />
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <div>
                        <label className="label">Player 1 name *</label>
                        <input name="player_1_name" required className="input" />
                      </div>
                      <PlayerPhotoField name="player_1" folder="tournament-player" label="Player 1 photo" />
                    </div>
                    <div className="space-y-2">
                      <div>
                        <label className="label">Player 2 name *</label>
                        <input name="player_2_name" required className="input" />
                      </div>
                      <PlayerPhotoField name="player_2" folder="tournament-player" label="Player 2 photo" />
                    </div>
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="label">Phone</label>
                    <input name="phone" className="input" />
                  </div>
                  <div>
                    <label className="label">Internal notes</label>
                    <input name="notes" className="input" />
                  </div>
                </div>
                <button className="btn-primary">Save {noun}</button>
              </form>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-bold">{selected.team_name}</h3>
                  <p className="text-xs text-muted">{playerNames(selected)}</p>
                </div>
                <span className={`badge ${(CHECKIN_LABEL[selected.check_in_status] ?? CHECKIN_LABEL.not_arrived)[1]}`}>
                  {(CHECKIN_LABEL[selected.check_in_status] ?? CHECKIN_LABEL.not_arrived)[0]}
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {selected.check_in_status !== "checked_in" && selected.team_status === "active" && (
                  <form action={setCheckIn}>
                    <input type="hidden" name="tournament_id" value={tournamentId} />
                    <input type="hidden" name="team_id" value={selected.id} />
                    <input type="hidden" name="status" value="checked_in" />
                    <button className="btn-primary px-3 py-1 text-xs">Check in</button>
                  </form>
                )}
                {selected.check_in_status === "checked_in" && (
                  <form action={setCheckIn}>
                    <input type="hidden" name="tournament_id" value={tournamentId} />
                    <input type="hidden" name="team_id" value={selected.id} />
                    <input type="hidden" name="status" value="not_arrived" />
                    <button className="btn-secondary px-3 py-1 text-xs">Undo check-in</button>
                  </form>
                )}
                {selected.team_status === "active" && selected.check_in_status !== "no_show" && (
                  <form action={setCheckIn}>
                    <input type="hidden" name="tournament_id" value={tournamentId} />
                    <input type="hidden" name="team_id" value={selected.id} />
                    <input type="hidden" name="status" value="no_show" />
                    <button className="btn-secondary px-3 py-1 text-xs">No-show</button>
                  </form>
                )}
                {selected.team_status === "active" ? (
                  <form action={setTeamStatus}>
                    <input type="hidden" name="tournament_id" value={tournamentId} />
                    <input type="hidden" name="team_id" value={selected.id} />
                    <input type="hidden" name="status" value="disqualified" />
                    <ConfirmSubmit
                      className="btn-secondary px-3 py-1 text-xs text-danger"
                      message={`Disqualify ${selected.team_name}? Future matches become walkovers. You can restore the ${noun} later.`}
                    >
                      Disqualify
                    </ConfirmSubmit>
                  </form>
                ) : (
                  <form action={setTeamStatus}>
                    <input type="hidden" name="tournament_id" value={tournamentId} />
                    <input type="hidden" name="team_id" value={selected.id} />
                    <input type="hidden" name="status" value="active" />
                    <ConfirmSubmit className="btn-secondary px-3 py-1 text-xs" message={`Restore ${selected.team_name}?`}>
                      Restore
                    </ConfirmSubmit>
                  </form>
                )}
                <form action={deleteTeam}>
                  <input type="hidden" name="tournament_id" value={tournamentId} />
                  <input type="hidden" name="team_id" value={selected.id} />
                  <ConfirmSubmit
                    className="btn-secondary px-3 py-1 text-xs text-danger"
                    message={`Delete ${selected.team_name} permanently?`}
                  >
                    Delete
                  </ConfirmSubmit>
                </form>
              </div>

              {/* Keyed on the team, so switching selection resets every field
                  rather than leaving the previous entry's photo in the form. */}
              <form action={updateTeam} className="space-y-3 border-t border-border pt-3" key={selected.id}>
                <input type="hidden" name="tournament_id" value={tournamentId} />
                <input type="hidden" name="team_id" value={selected.id} />
                <div>
                  <label className="label">{isChess ? "Player name" : "Team name"}</label>
                  <input name="team_name" defaultValue={selected.team_name} className="input" />
                </div>

                {isChess ? (
                  <PlayerPhotoField
                    name="player_1"
                    folder="tournament-player"
                    label="Photo"
                    photoUrl={selected.players?.[0]?.photo_url ?? null}
                    focalX={selected.players?.[0]?.focal_x}
                    focalY={selected.players?.[0]?.focal_y}
                  />
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {[0, 1].map((i) => (
                      <div key={i} className="space-y-2">
                        <div>
                          <label className="label">Player {i + 1}</label>
                          <input
                            name={`player_${i + 1}_name`}
                            defaultValue={selected.players?.[i]?.full_name ?? ""}
                            className="input"
                          />
                        </div>
                        <PlayerPhotoField
                          name={`player_${i + 1}`}
                          folder="tournament-player"
                          label={`Player ${i + 1} photo`}
                          photoUrl={selected.players?.[i]?.photo_url ?? null}
                          focalX={selected.players?.[i]?.focal_x}
                          focalY={selected.players?.[i]?.focal_y}
                        />
                      </div>
                    ))}
                  </div>
                )}

                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="label">Phone</label>
                    <input name="phone" defaultValue={selected.phone ?? ""} className="input" />
                  </div>
                  <div>
                    <label className="label">Internal notes</label>
                    <input name="notes" defaultValue={selected.notes ?? ""} className="input" />
                  </div>
                </div>
                <button className="btn-primary">Save changes</button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
