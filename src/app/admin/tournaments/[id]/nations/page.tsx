import { getTeams, getTournament } from "@/lib/data";
import { NATIONS } from "@/lib/tennis/nations";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import PlayerPhotoField from "@/components/PlayerPhotoField";
import SessionRowNotice from "../SessionRowNotice";
import type { Team } from "@/lib/types";
import { addNation, deleteNation, updateNation } from "./actions";

export const dynamic = "force-dynamic";

const SLOTS = [1, 2, 3, 4];

function NationFields({ team, tournamentId }: { team?: Team; tournamentId: string }) {
  const players = team?.players ?? [];
  const idSuffix = team?.id ?? "new";
  return (
    <>
      <input type="hidden" name="tournament_id" value={tournamentId} />
      {team && <input type="hidden" name="team_id" value={team.id} />}
      <div className="grid gap-2 sm:grid-cols-4">
        <div>
          <label className="label" htmlFor={`code-${idSuffix}`}>ITF code *</label>
          <input
            id={`code-${idSuffix}`}
            name="nation_code"
            list="itf-codes"
            required
            maxLength={3}
            defaultValue={team?.nation_code ?? ""}
            className="input uppercase"
            placeholder="EGY"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`name-${idSuffix}`}>Nation</label>
          <input id={`name-${idSuffix}`} name="team_name" defaultValue={team?.team_name ?? ""} className="input" placeholder="Filled from the code" />
        </div>
        <div>
          <label className="label" htmlFor={`seed-${idSuffix}`}>Seed</label>
          <input id={`seed-${idSuffix}`} name="seed_number" type="number" min={1} defaultValue={team?.seed_number ?? ""} className="input" />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`captain-${idSuffix}`}>Captain</label>
        <input id={`captain-${idSuffix}`} name="captain_name" defaultValue={team?.captain_name ?? ""} className="input" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {SLOTS.map((n) => {
          const p = players.find((x) => x.player_order === n);
          return (
            <div key={n} className="space-y-2 rounded-xl border border-border p-2">
              <label className="label" htmlFor={`p${n}-${idSuffix}`}>
                Player {n}
                {n <= 2 ? " *" : n === 4 ? " (reserve)" : ""}
              </label>
              <input id={`p${n}-${idSuffix}`} name={`player_${n}_name`} required={!team && n <= 2} defaultValue={p?.full_name ?? ""} className="input" />
              <PlayerPhotoField
                name={`player_${n}`}
                folder="tournament-player"
                label="Photo"
                photoUrl={p?.photo_url ?? null}
                focalX={p?.focal_x}
                focalY={p?.focal_y}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

export default async function NationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tournament, teams] = await Promise.all([getTournament(id), getTeams(id)]);
  if (tournament && tournament.kind !== "tournament") return <SessionRowNotice tournamentId={id} tool="Nations" />;
  const sorted = [...teams].sort((a, b) => (a.seed_number ?? 999) - (b.seed_number ?? 999) || a.team_name.localeCompare(b.team_name));

  return (
    <div className="space-y-4">
      <datalist id="itf-codes">
        {NATIONS.map((n) => (
          <option key={n.code} value={n.code}>{n.name}</option>
        ))}
      </datalist>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">Nations ({teams.length})</h2>
        <p className="text-xs text-muted">Three players and a captain per nation; a fourth is a reserve. The code sets the flag.</p>
      </div>

      <details className="card space-y-3" open={teams.length === 0}>
        <summary className="cursor-pointer font-bold">+ Add a nation</summary>
        <form action={addNation} className="mt-3 space-y-3">
          <NationFields tournamentId={id} />
          <button type="submit" className="btn-primary">Add nation</button>
        </form>
      </details>

      <div className="space-y-2">
        {sorted.map((t) => (
          <details key={t.id} className="card" data-testid="nation-row">
            <summary className="flex cursor-pointer flex-wrap items-center gap-3">
              <span className="w-12 font-mono text-sm font-bold">{t.nation_code ?? "—"}</span>
              <span className="font-bold">{t.team_name}</span>
              {t.seed_number && <span className="badge bg-card text-muted">Seed {t.seed_number}</span>}
              <span className="text-xs text-muted">
                {(t.players ?? []).map((p) => p.full_name).join(" · ")}
                {t.captain_name ? ` — captain ${t.captain_name}` : ""}
              </span>
            </summary>
            <form action={updateNation} className="mt-3 space-y-3">
              <NationFields team={t} tournamentId={id} />
              <button type="submit" className="btn-primary">Save</button>
            </form>
            <form action={deleteNation} className="mt-2">
              <input type="hidden" name="tournament_id" value={id} />
              <input type="hidden" name="team_id" value={t.id} />
              <ConfirmSubmit message={`Delete ${t.team_name} and its players?`} className="btn-secondary text-xs text-danger">
                Delete nation
              </ConfirmSubmit>
            </form>
          </details>
        ))}
      </div>
    </div>
  );
}
