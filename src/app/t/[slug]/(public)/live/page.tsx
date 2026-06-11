import Link from "next/link";
import { notFound } from "next/navigation";
import { getCourts, getMatches, getSnapshots, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import LiveMatchCard from "@/components/LiveMatchCard";

export const dynamic = "force-dynamic";

export default async function PublicLive({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament) notFound();
  const id = tournament.id;
  const [matches, teams, snapshots, courts] = await Promise.all([
    getMatches(id),
    getTeams(id),
    getSnapshots(id),
    getCourts(id),
  ]);
  const tm = teamMap(teams);
  const snapByMatch = new Map(snapshots.map((s) => [s.match_id, s]));
  const courtName = new Map(courts.map((c) => [c.id, c.court_name]));
  const live = matches.filter((m) => ["live", "paused"].includes(m.status));
  const recent = matches
    .filter((m) => ["completed", "walkover", "retired", "disqualified"].includes(m.status))
    .sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""))
    .slice(0, 6);

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={5} />
      <h2 className="text-xl font-bold">Live matches</h2>
      {live.length === 0 && <p className="card p-8 text-center text-muted">No live matches right now.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {live.map((m) => (
          <Link key={m.id} href={`/t/${slug}/match/${m.id}`}>
            <LiveMatchCard
              match={m}
              snapshot={snapByMatch.get(m.id) ?? null}
              teamA={m.team_a_id ? tm.get(m.team_a_id) : undefined}
              teamB={m.team_b_id ? tm.get(m.team_b_id) : undefined}
              courtName={m.court_id ? courtName.get(m.court_id) : undefined}
            />
          </Link>
        ))}
      </div>

      {recent.length > 0 && (
        <section className="space-y-2">
          <h3 className="label">Recent results</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {recent.map((m) => (
              <LiveMatchCard
                key={m.id}
                match={m}
                snapshot={snapByMatch.get(m.id) ?? null}
                teamA={m.team_a_id ? tm.get(m.team_a_id) : undefined}
                teamB={m.team_b_id ? tm.get(m.team_b_id) : undefined}
                courtName={m.court_id ? courtName.get(m.court_id) : undefined}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
