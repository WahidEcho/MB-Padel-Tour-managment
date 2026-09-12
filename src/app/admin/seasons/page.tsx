import { db } from "@/lib/supabase";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { listSeasons } from "@/lib/friendly/data";
import { createSeason, deleteSeason, setSeasonStatus, updateSeason } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  upcoming: "bg-warning/15 text-warning",
  active: "bg-success/15 text-success",
  closed: "bg-border text-muted",
};

export default async function SeasonsPage() {
  const seasons = await listSeasons();

  // Session counts per season, so an admin can see what a season holds
  // before closing or deleting it.
  const { data: sessionRows } = await db()
    .from("friendly_sessions")
    .select("season_id")
    .not("season_id", "is", null);
  const counts = new Map<string, number>();
  for (const r of (sessionRows ?? []) as { season_id: string }[]) {
    counts.set(r.season_id, (counts.get(r.season_id) ?? 0) + 1);
  }

  const active = seasons.find((s) => s.status === "active");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Seasons</h1>
        {active ? (
          <span className="badge bg-success/15 text-success">Active: {active.name}</span>
        ) : (
          <span className="badge bg-warning/15 text-warning">No active season</span>
        )}
      </div>

      <p className="text-xs text-muted">
        A season groups friendly sessions for the Season ranking. Only one can be active at a time —
        activating another closes the current one. Sessions finalized with no active season still
        count toward Lifetime rankings.
      </p>

      <details className="card">
        <summary className="cursor-pointer font-bold">New season</summary>
        <form action={createSeason} className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="season-name">Name</label>
            <input id="season-name" name="name" className="input" placeholder="Autumn 2026" required />
          </div>
          <div>
            <label className="label" htmlFor="season-start">Starts on</label>
            <input id="season-start" name="starts_on" type="date" className="input" />
          </div>
          <div>
            <label className="label" htmlFor="season-end">Ends on</label>
            <input id="season-end" name="ends_on" type="date" className="input" />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="make_active" />
            Make this the active season (closes the current one)
          </label>
          <div className="sm:col-span-2">
            <button className="btn-primary text-sm">Create season</button>
          </div>
        </form>
      </details>

      {seasons.length === 0 && (
        <p className="card p-8 text-center text-muted">
          No seasons yet. Create one to start grouping friendly sessions.
        </p>
      )}

      <div className="space-y-2">
        {seasons.map((s) => {
          const sessionCount = counts.get(s.id) ?? 0;
          return (
            <div key={s.id} className="card space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-bold">
                    {s.name}{" "}
                    <span className={`badge ${STATUS_BADGE[s.status] ?? "bg-border text-muted"}`}>
                      {s.status}
                    </span>
                  </h2>
                  <p className="text-xs text-muted">
                    {s.starts_on ?? "no start date"} → {s.ends_on ?? "no end date"} ·{" "}
                    {sessionCount} session{sessionCount === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {s.status !== "active" && (
                    <form action={setSeasonStatus}>
                      <input type="hidden" name="season_id" value={s.id} />
                      <input type="hidden" name="status" value="active" />
                      <ConfirmSubmit
                        className="btn-secondary text-xs"
                        message="Make this the active season? The current active season will be closed."
                      >
                        Make active
                      </ConfirmSubmit>
                    </form>
                  )}
                  {s.status !== "closed" && (
                    <form action={setSeasonStatus}>
                      <input type="hidden" name="season_id" value={s.id} />
                      <input type="hidden" name="status" value="closed" />
                      <button className="btn-secondary text-xs">Close</button>
                    </form>
                  )}
                  {sessionCount === 0 && (
                    <form action={deleteSeason}>
                      <input type="hidden" name="season_id" value={s.id} />
                      <ConfirmSubmit
                        className="btn-secondary text-xs text-danger"
                        message="Delete this season? This cannot be undone."
                      >
                        Delete
                      </ConfirmSubmit>
                    </form>
                  )}
                </div>
              </div>

              <details>
                <summary className="cursor-pointer text-xs font-semibold text-muted">Edit</summary>
                <form action={updateSeason} className="mt-2 grid gap-2 sm:grid-cols-4">
                  <input type="hidden" name="season_id" value={s.id} />
                  <input name="name" defaultValue={s.name} className="input text-sm sm:col-span-2" required />
                  <input name="starts_on" type="date" defaultValue={s.starts_on ?? ""} className="input text-sm" />
                  <input name="ends_on" type="date" defaultValue={s.ends_on ?? ""} className="input text-sm" />
                  <div className="sm:col-span-4">
                    <button className="btn-secondary text-xs">Save changes</button>
                  </div>
                </form>
              </details>
            </div>
          );
        })}
      </div>
    </div>
  );
}
