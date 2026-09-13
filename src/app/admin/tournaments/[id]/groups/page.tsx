import Link from "next/link";
import { notFound } from "next/navigation";
import { getGroups, getGroupTeams, getMatches, getTeams, getTournament } from "@/lib/data";
import { bracketsPhrase } from "@/lib/bracket";
import { NOT_A_TOURNAMENT_MESSAGE, summarizeBrackets } from "@/lib/ops";
import { createGroups } from "./actions";
import GroupsClient from "./GroupsClient";

export const dynamic = "force-dynamic";

export default async function GroupsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tournament, teams, groups, groupTeams, matches, brackets] = await Promise.all([
    getTournament(id),
    getTeams(id),
    getGroups(id),
    getGroupTeams(id),
    getMatches(id),
    summarizeBrackets(id),
  ]);
  if (!tournament) notFound();
  // A friendly session's hidden tournament: its groups belong to the session's own
  // format tools, and its knockout is seeded from pairs, not from these groups.
  const isSession = tournament.kind !== "tournament";
  const locked = isSession || brackets.length > 0;
  const groupMatchCount = matches.filter((m) => m.stage === "group").length;
  const finishedCount = matches.filter(
    (m) => m.stage === "group" && !["scheduled", "ready"].includes(m.status)
  ).length;

  return (
    <div className="space-y-4">
      {isSession ? (
        <div className="card space-y-1 border-warning/50" data-testid="group-draw-session">
          <p className="font-semibold">Groups are managed from the session.</p>
          <p className="text-sm text-muted">
            {NOT_A_TOURNAMENT_MESSAGE}{" "}
            <Link href="/admin/friendly-sessions" className="font-semibold text-accent">Friendly sessions</Link>
          </p>
        </div>
      ) : locked ? (
        // Recreating groups deletes their standings through the database's cascade,
        // so the draw stays fixed while a knockout seeded from it exists.
        <div className="card space-y-1 border-warning/50" data-testid="group-draw-locked">
          <p className="font-semibold">The group draw is locked.</p>
          <p className="text-sm text-muted">
            {bracketsPhrase(brackets).replace(/^./, (c) => c.toUpperCase())} {brackets.length === 1 ? "was" : "were"} drawn
            from these groups. Reset {brackets.length === 1 ? "it" : "them"} on the{" "}
            <Link href={`/admin/tournaments/${id}/bracket`} className="font-semibold text-accent">Bracket page</Link>{" "}
            before recreating groups or changing the draw.
          </p>
        </div>
      ) : (
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
              ⚠ Recreating or re-drawing groups does not change the schedule until you publish again, which
              regenerates every group match.
              {finishedCount > 0 && ` ${finishedCount} match(es) already played will lose their scores then.`}
            </span>
          )}
        </p>
      </div>

      )}

      {groups.length > 0 && (
        <GroupsClient
          // Remounted when the lock changes, so an unsaved arrangement made before
          // a bracket was drawn is thrown away rather than stranded on screen.
          key={locked ? "locked" : "open"}
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
          brackets={brackets}
          lockedReason={
            isSession
              ? "The draw belongs to the friendly session and is changed from the session's page."
              : locked
                ? "The draw is locked while a knockout bracket exists, because the bracket was seeded from these groups."
                : null
          }
          canRegenerate={!isSession}
        />
      )}
    </div>
  );
}
