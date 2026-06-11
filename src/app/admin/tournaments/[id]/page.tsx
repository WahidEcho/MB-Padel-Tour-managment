import Link from "next/link";
import { notFound } from "next/navigation";
import { getCourts, getGroups, getMatches, getTeams, getTournament } from "@/lib/data";
import { resetTournamentData, setTournamentStatus, deleteTournament } from "../actions";
import ConfirmSubmit from "@/components/ConfirmSubmit";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const [teams, groups, matches, courts] = await Promise.all([
    getTeams(id),
    getGroups(id),
    getMatches(id),
    getCourts(id),
  ]);

  const checkedIn = teams.filter((t) => t.check_in_status === "checked_in").length;
  const live = matches.filter((m) => ["live", "paused"].includes(m.status));
  const done = matches.filter((m) =>
    ["completed", "walkover", "disqualified", "retired"].includes(m.status)
  ).length;

  const stats: [string, string | number, string][] = [
    ["Teams", teams.length, `/admin/tournaments/${id}/teams`],
    ["Checked in", `${checkedIn}/${teams.length}`, `/admin/tournaments/${id}/teams`],
    ["Groups", groups.length, `/admin/tournaments/${id}/groups`],
    ["Courts", courts.length, `/admin/tournaments/${id}/settings`],
    ["Matches", matches.length, `/admin/tournaments/${id}/matches`],
    ["Finished", `${done}/${matches.length}`, `/admin/tournaments/${id}/matches`],
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map(([label, value, href]) => (
          <Link key={label} href={href} className="card text-center hover:border-accent">
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
          </Link>
        ))}
      </div>

      {live.length > 0 && (
        <div className="card border-accent/40">
          <h2 className="label">Live now</h2>
          <ul className="mt-1 space-y-1 text-sm">
            {live.map((m) => (
              <li key={m.id}>
                <Link className="font-semibold text-accent hover:underline" href={`/referee/matches/${m.id}/score`}>
                  {m.round_name} — open scoring →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card space-y-3">
        <h2 className="label">Tournament status</h2>
        <div className="flex flex-wrap gap-2">
          {(["draft", "active", "completed", "archived"] as const).map((status) => (
            <form key={status} action={setTournamentStatus}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="status" value={status} />
              <button
                type="submit"
                className={tournament.status === status ? "btn-primary" : "btn-secondary"}
                disabled={tournament.status === status}
              >
                {status}
              </button>
            </form>
          ))}
        </div>
        <p className="text-xs text-muted">
          Set to <b>active</b> on event day so the tournament appears on public screens.
        </p>
      </div>

      <div className="card space-y-3 border-danger/30">
        <h2 className="label text-danger">Danger zone</h2>
        <div className="flex flex-wrap gap-2">
          <form action={resetTournamentData}>
            <input type="hidden" name="id" value={id} />
            <ConfirmSubmit
              className="btn-secondary"
              message="Reset ALL scores, matches, leaderboard, bracket, and check-in for this tournament? Setup (teams, groups, courts, branding) is kept."
            >
              Reset scores &amp; live data
            </ConfirmSubmit>
          </form>
          <form action={deleteTournament}>
            <input type="hidden" name="id" value={id} />
            <ConfirmSubmit message={`Delete tournament "${tournament.name}" permanently? This cannot be undone.`}>
              Delete tournament
            </ConfirmSubmit>
          </form>
        </div>
      </div>
    </div>
  );
}
