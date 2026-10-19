import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTournamentPage } from "@/lib/guard";
import { staffCan } from "@/lib/auth";
import { getCourts, getGroups, getTeams, getTournament } from "@/lib/data";
import { summarizeBrackets } from "@/lib/ops";
import { getTies, isTieFormat } from "@/lib/tennis/tieOps";
import AutoRefresh from "@/components/AutoRefresh";
import { sportOf } from "@/lib/sports/registry";
import GroupStageRegenerateForm from "@/app/admin/tournaments/[id]/GroupStageRegenerateForm";
import { createManualMatch, regenerateMatches } from "@/app/admin/tournaments/[id]/matches/actions";
import { generateTiesAction } from "@/app/admin/tournaments/[id]/ties/actions";
import { PlacementControls } from "@/app/admin/tournaments/[id]/ties/TieForms";

export const dynamic = "force-dynamic";

/**
 * The match desk for a master referee (migration 0035): the admin desk's own tools for
 * adding matches and generating them from the draw, for an event the master referee
 * covers. The actions are the admin pages' own (src/app/admin/tournaments/[id]/…/actions.ts)
 * with their own guards; a master referee passes them only for its events
 * (MASTER_REFEREE_PERMISSIONS in src/lib/auth.ts, scope in src/lib/orgs/scope.ts).
 */
export default async function MatchDeskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { staff } = await requireTournamentPage(id, ["referee", "admin", "manager"], `/referee/tournaments/${id}/desk`);
  if (!staffCan(staff, "generate_matches")) notFound();
  const tournament = await getTournament(id);
  if (!tournament || tournament.kind !== "tournament") notFound();
  const [teams, groups, courts, brackets] = await Promise.all([getTeams(id), getGroups(id), getCourts(id), summarizeBrackets(id)]);
  const tieFormat = isTieFormat(tournament);
  const ties = tieFormat ? await getTies(id) : [];
  const groupTies = ties.filter((t) => t.stage === "group");
  const placementTies = ties.filter((t) => t.stage === "placement");
  const groupsDone = groupTies.length > 0 && groupTies.every((t) => t.status === "completed");

  return (
    <div className="space-y-5" data-testid="match-desk">
      <AutoRefresh seconds={10} />
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Match desk</p>
        <h1 className="text-xl font-bold">{tournament.name}</h1>
        <p className="text-xs text-muted">
          The desk&apos;s tools for this event. <Link href={`/referee/tournaments/${id}/matches`} className="underline">All matches</Link> ·{" "}
          <Link href="/referee/master" className="underline">Calls &amp; courts</Link>
        </p>
      </div>

      {tieFormat ? (
        <section className="card space-y-3">
          <h2 className="font-bold">Ties from the draw</h2>
          {groupTies.length === 0 ? (
            <form action={generateTiesAction}>
              <input type="hidden" name="tournament_id" value={id} />
              <button type="submit" className="btn-primary" disabled={groups.length === 0} data-testid="desk-generate-ties">Generate the group ties</button>
              {groups.length === 0 && <p className="mt-1 text-xs text-muted">The nations are not drawn into groups yet (the desk does it on the Groups page).</p>}
            </form>
          ) : (
            <p className="text-sm text-muted">{groupTies.length} group ties generated.</p>
          )}
          {groupTies.length > 0 && <PlacementControls tournamentId={id} drawn={placementTies.length > 0} ready={groupsDone} groupCount={groups.length} />}
        </section>
      ) : (
        groups.length > 0 &&
        sportOf(tournament).engine !== "chess" && (
          <section className="card space-y-2">
            <h2 className="font-bold">Group matches from the draw</h2>
            <GroupStageRegenerateForm
              tournamentId={id}
              action={regenerateMatches}
              brackets={brackets}
              label="Generate group matches"
              confirmMessage="Generate ALL group matches from the draw? Existing group match scores will be deleted."
            />
          </section>
        )
      )}

      <section className="card space-y-2">
        <h2 className="font-bold">Add a match</h2>
        <form action={createManualMatch} className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="desk-add-match">
          <input type="hidden" name="tournament_id" value={id} />
          <select name="team_a_id" required className="input">
            <option value="">Side A…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.team_name}</option>
            ))}
          </select>
          <select name="team_b_id" required className="input">
            <option value="">Side B…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.team_name}</option>
            ))}
          </select>
          <select name="group_id" className="input">
            <option value="">No group (knockout / friendly)</option>
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
      </section>
    </div>
  );
}
