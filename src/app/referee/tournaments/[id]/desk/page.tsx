import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTournamentPage } from "@/lib/guard";
import { staffCan } from "@/lib/auth";
import { getCourts, getGroups, getTeams, getTournament } from "@/lib/data";
import { summarizeBrackets } from "@/lib/ops";
import { getTies, isTieFormat } from "@/lib/tennis/tieOps";
import AutoRefresh from "@/components/AutoRefresh";
import LineupSheet from "@/components/lineups/LineupSheet";
import { eventDay } from "@/lib/matchday/eventDay";
import { EVENT_TIME_ZONE } from "@/lib/tennis/ties";
import { db } from "@/lib/supabase";
import { sportOf } from "@/lib/sports/registry";
import GroupStageRegenerateForm from "@/app/admin/tournaments/[id]/GroupStageRegenerateForm";
import ManualMatchForm from "@/components/matches/ManualMatchForm";
import type { ExistingMatch } from "@/lib/matches/manualMatchWarnings";
import { createManualMatch, regenerateMatches } from "@/app/admin/tournaments/[id]/matches/actions";
import { generateTiesAction } from "@/app/admin/tournaments/[id]/ties/actions";
import { PlacementControls } from "@/app/admin/tournaments/[id]/ties/TieForms";

export const dynamic = "force-dynamic";

/**
 * The match desk for a master referee (migration 0035): the admin desk's own tools for
 * adding matches and generating them from the draw, for an event the master referee
 * covers. The actions are the admin pages' own (src/app/admin/tournaments/[id]/…/actions.ts)
 * with their own guards; a master referee passes them only for its events
 * (`master_desk`, MASTER_REFEREE_PERMISSIONS in src/lib/auth.ts, scope in src/lib/orgs/scope.ts).
 * Deleting matches, brackets, groups and resetting the placement draws stay the organiser's.
 */
export default async function MatchDeskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { staff } = await requireTournamentPage(id, ["referee", "admin", "manager"], `/referee/tournaments/${id}/desk`);
  if (!staffCan(staff, "master_desk")) notFound();
  const tournament = await getTournament(id);
  if (!tournament || tournament.kind !== "tournament") notFound();
  const [teams, groups, courts, brackets] = await Promise.all([getTeams(id), getGroups(id), getCourts(id), summarizeBrackets(id)]);
  const tieFormat = isTieFormat(tournament);
  const ties = tieFormat ? await getTies(id) : [];
  const groupTies = ties.filter((t) => t.stage === "group");
  const placementTies = ties.filter((t) => t.stage === "placement");
  const groupsDone = groupTies.length > 0 && groupTies.every((t) => t.status === "completed");
  const teamBy = new Map(teams.map((t) => [t.id, t]));
  const nation = (id: string | null) => (id ? (teamBy.get(id)?.nation_code ?? teamBy.get(id)?.team_name ?? "?") : "TBD");
  const courtName = new Map(courts.map((c) => [c.id, c.court_name]));
  // The first rubber of each tie: the line-up page is reached through a rubber.
  const { data: rubberRows } = tieFormat ? await db().from("matches").select("id, tie_id, rubber_no").eq("tournament_id", id).not("tie_id", "is", null).order("rubber_no") : { data: [] };
  // What a match added by hand would clash with (warnings only, ManualMatchForm).
  const { data: existingRows } = await db().from("matches").select("team_a_id, team_b_id, court_id, status, scheduled_time, tie_id").eq("tournament_id", id);
  const existing = (existingRows ?? []) as ExistingMatch[];
  const firstRubber = new Map<string, string>();
  for (const r of (rubberRows ?? []) as { id: string; tie_id: string }[]) if (!firstRubber.has(r.tie_id)) firstRubber.set(r.tie_id, r.id);

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
          {groupTies.length > 0 && <PlacementControls tournamentId={id} drawn={placementTies.length > 0} ready={groupsDone} groupCount={groups.length} canReset={staffCan(staff, "manage_groups")} />}
        </section>
      ) : null}

      {tieFormat && ties.some((t) => t.status !== "completed") ? (
        <>
          {/* Line-ups on match day: the sheet for the whole day, or one tie at a time. */}
          <LineupSheet tournamentId={id} defaultDay={eventDay(EVENT_TIME_ZONE)} />
          <section className="card space-y-2" data-testid="desk-ties">
            <h2 className="font-bold">Line-ups, tie by tie</h2>
            <ul className="divide-y divide-border text-sm">
              {ties
                .filter((t) => t.status !== "completed" && t.team_a_id && t.team_b_id && firstRubber.get(t.id))
                .map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>
                      <span className="font-semibold">{nation(t.team_a_id)} v {nation(t.team_b_id)}</span>
                      <span className="text-xs text-muted"> · {t.round_name}{t.court_id ? ` · ${courtName.get(t.court_id) ?? ""}` : ""}{t.lineup_locked_at ? " · singles locked" : " · line-ups open"}</span>
                    </span>
                    <Link href={`/referee/matches/${firstRubber.get(t.id)}/lineup`} className="btn-secondary py-1 text-xs" data-testid="desk-lineup-link">Line-up</Link>
                  </li>
                ))}
            </ul>
          </section>
        </>
      ) : null}

      {tieFormat ? null : (
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
        <div data-testid="desk-add-match">
          <ManualMatchForm
            action={createManualMatch}
            tournamentId={id}
            teams={teams.map((t) => ({ id: t.id, name: t.team_name }))}
            groups={groups.map((g) => ({ id: g.id, name: g.group_name }))}
            courts={courts.map((c) => ({ id: c.id, name: c.court_name }))}
            existing={existing}
            tieFormat={tieFormat}
            timeZone={EVENT_TIME_ZONE}
          />
        </div>
      </section>
    </div>
  );
}
