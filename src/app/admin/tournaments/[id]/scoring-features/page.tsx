import { notFound } from "next/navigation";
import { requireTournamentPage } from "@/lib/guard";
import { getTournament } from "@/lib/data";
import { SCORING_FEATURE_GROUPS, matchDayRules } from "@/lib/matchday/rules";
import { sportOf } from "@/lib/sports/registry";
import { saveScoringFeatures } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Scoring v2: which referee buttons, timers and TV extras this tournament uses.
 * Admins change them; managers see them read-only. Referees and master referees
 * never reach admin pages.
 */
export default async function ScoringFeaturesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { staff } = await requireTournamentPage(id, ["admin", "manager"], `/admin/tournaments/${id}/scoring-features`);
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const sport = sportOf(tournament);
  const features = matchDayRules(tournament.match_day_rules, tournament).features;
  const canEdit = staff.role === "admin" || staff.platformAdmin;

  return (
    <div className="space-y-4" data-testid="scoring-features">
      <section className="card flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-bold">Scoring features — {tournament.name}</h2>
          <p className="text-sm text-muted">
            Choose which referee buttons, timers and TV extras this tournament uses. Changes apply the next time a referee opens a match.
          </p>
        </div>
        <span className="badge bg-warning/15 text-warning">Only admins can change these</span>
      </section>
      {sport.engine !== "games" ? (
        <p className="card text-sm text-muted">Not available for {sport.label.toLowerCase()}.</p>
      ) : (
        <form action={saveScoringFeatures} className="space-y-4">
          <input type="hidden" name="tournament_id" value={id} />
          <fieldset disabled={!canEdit} className="grid gap-4 lg:grid-cols-2">
            {SCORING_FEATURE_GROUPS.map((g) => (
              <div key={g.title} className="card space-y-0 p-0">
                <p className="label px-4 pt-3">{g.title}</p>
                {g.rows.map(([key, title, hint]) => (
                  <label key={key} className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm">
                    <span>
                      <span className="font-semibold">{title}</span>
                      <span className="block text-xs text-muted">{hint}</span>
                    </span>
                    <input type="checkbox" name={key} defaultChecked={features[key]} className="switch" data-testid={`feature-${key}`} />
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" name="intent" value="save" data-testid="features-save">Save</button>
              <button className="btn-secondary" name="intent" value="all_on">Switch all on</button>
              <button className="btn-secondary" name="intent" value="all_off">Switch all off</button>
            </div>
          ) : (
            <p className="text-sm text-muted">Read-only: ask an admin to change these.</p>
          )}
        </form>
      )}
    </div>
  );
}
