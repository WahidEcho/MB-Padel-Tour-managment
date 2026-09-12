import Link from "next/link";
import { listSeasons } from "@/lib/friendly/data";
import { createSessionAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewSessionPage() {
  const seasons = await listSeasons();
  const active = seasons.find((s) => s.status === "active");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">New friendly session</h1>
        <Link href="/admin/friendly-sessions" className="text-sm text-muted hover:text-foreground">
          Cancel
        </Link>
      </div>

      <form action={createSessionAction} className="card grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="s-name">Session name</label>
          <input id="s-name" name="name" className="input" placeholder="Tuesday Social" required />
        </div>

        <div>
          <label className="label" htmlFor="s-season">Season</label>
          <select id="s-season" name="season_id" defaultValue={active?.id ?? ""} className="input">
            <option value="">No season (Lifetime only)</option>
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.status === "active" ? " (active)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="s-starts">Starts at</label>
          <input id="s-starts" name="starts_at" type="datetime-local" className="input" />
        </div>

        <div>
          <label className="label" htmlFor="s-pairing">Pairing mode</label>
          <select id="s-pairing" name="pairing_mode" defaultValue="americano" className="input">
            <option value="fixed">Fixed partners — partners stay, opponents rotate</option>
            <option value="americano">Americano — partners rotate every round</option>
            <option value="mexicano">Mexicano — re-paired each round by standings</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="s-ranking">Ranking model</label>
          <select id="s-ranking" name="ranking_model" defaultValue="win_points" className="input">
            <option value="win_points">Win points — 3 per win, plus fire streak</option>
            <option value="games_won">Games won — bank the games your side wins</option>
          </select>
          <p className="mt-1 text-xs text-muted">
            Games won suits Americano/Mexicano: losing 4-6 still banks 4, so close matches count.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="s-sets">Sets to win a match</label>
          <select id="s-sets" name="sets_to_win" defaultValue="1" className="input">
            <option value="1">One set (~30 min) — recommended for rotation</option>
            <option value="2">Best of 3 (~60 min)</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="s-games">Games to win a set</label>
          <input id="s-games" name="games_to_win" type="number" min={1} max={9} defaultValue={6} className="input" />
        </div>

        <div>
          <label className="label" htmlFor="s-courts">Courts</label>
          <input id="s-courts" name="courts" type="number" min={1} max={20} defaultValue={2} className="input" />
        </div>

        <div>
          <label className="label" htmlFor="s-duration">Duration (minutes)</label>
          <input id="s-duration" name="duration_minutes" type="number" min={1} className="input" placeholder="leave empty for no limit" />
          <p className="mt-1 text-xs text-muted">Optional. Only used to estimate how many rounds fit — it never trims the draw.</p>
        </div>

        <div>
          <label className="label" htmlFor="s-registration">Who can register</label>
          <select id="s-registration" name="registration_mode" defaultValue="individual" className="input">
            <option value="individual">Individuals — one player per sign-up</option>
            <option value="team">Teams — both players in one sign-up</option>
            <option value="either">Either — the player chooses</option>
          </select>
          <p className="mt-1 text-xs text-muted">Rotating formats need individuals; fixed partners suit teams.</p>
        </div>

        <div>
          <label className="label" htmlFor="s-scoring">Referee scoring</label>
          <select id="s-scoring" name="scoring_mode" defaultValue="point_by_point" className="input">
            <option value="point_by_point">Point by point — full live scoring</option>
            <option value="final_score">Final score only — quick entry</option>
          </select>
          <p className="mt-1 text-xs text-muted">A referee can switch this on any individual match.</p>
        </div>

        <div>
          <label className="label" htmlFor="s-max">Max players (optional)</label>
          <input id="s-max" name="max_players" type="number" min={4} max={200} className="input" placeholder="no limit" />
          <p className="mt-1 text-xs text-muted">Approvals past this go to the waitlist.</p>
        </div>

        <div>
          <label className="label" htmlFor="s-deadline">Registration deadline (optional)</label>
          <input id="s-deadline" name="registration_deadline" type="datetime-local" className="input" />
        </div>

        <div className="sm:col-span-2">
          <button className="btn-primary">Create session</button>
        </div>
      </form>
    </div>
  );
}
