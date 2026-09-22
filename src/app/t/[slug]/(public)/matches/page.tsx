import Link from "next/link";
import { notFound } from "next/navigation";
import { getCourts, getMatches, getSnapshots, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import { isFinished } from "@/lib/standings";
import AutoRefresh from "@/components/AutoRefresh";
import LiveMatchCard from "@/components/LiveMatchCard";
import ChessLiveCard from "@/components/ChessLiveCard";
import MatchStatusBadge from "@/components/MatchStatusBadge";
import type { Match } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Every match, at every stage, in one place.
 *
 * The Live page (`/live`) stays a fast last-6 snapshot for someone glued to
 * what's happening right now; it is deliberately untouched by this page. This
 * one is the complete record instead: nothing is capped, and — for the first
 * time anywhere in the public site — a completed match's card is a link, so a
 * finished result can be opened on its own page rather than only read in a list.
 *
 * Order: live pinned at the top, then what's still to come in schedule order,
 * then everything finished, most recently decided first.
 */
export default async function PublicMatches({ params }: { params: Promise<{ slug: string }> }) {
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
  const isChess = tournament.sport === "chess";

  const live = matches.filter((m) => ["live", "paused"].includes(m.status));
  // "cancelled" is a defensive status nothing currently writes for a tournament
  // match, but a schedule page still has to put it somewhere sane rather than
  // list it as if it were still coming up.
  const upcoming = matches.filter((m) => ["scheduled", "ready"].includes(m.status));
  const decided = matches
    .filter((m) => isFinished(m.status) || m.status === "cancelled")
    .sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));

  const renderCard = (m: Match) => {
    const common = {
      match: m,
      snapshot: snapByMatch.get(m.id) ?? null,
      teamA: m.team_a_id ? tm.get(m.team_a_id) : undefined,
      teamB: m.team_b_id ? tm.get(m.team_b_id) : undefined,
    };
    return isChess ? (
      <ChessLiveCard {...common} boardName={m.court_id ? courtName.get(m.court_id) : undefined} />
    ) : (
      <LiveMatchCard {...common} courtName={m.court_id ? courtName.get(m.court_id) : undefined} />
    );
  };

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={8} />
      <h2 className="text-xl font-bold">Matches</h2>

      {live.length > 0 && (
        <section className="space-y-2">
          <h3 className="label">Live now</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {live.map((m) => (
              <Link key={m.id} href={`/t/${slug}/match/${m.id}`}>
                {renderCard(m)}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="label">Upcoming</h3>
        {upcoming.length === 0 ? (
          <p className="card p-6 text-center text-muted">Nothing else scheduled.</p>
        ) : (
          <ul className="space-y-1.5">
            {upcoming.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/t/${slug}/match/${m.id}`}
                  className="card flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm hover:bg-card/80"
                >
                  <span className="font-semibold">
                    {m.team_a_id ? tm.get(m.team_a_id)?.team_name : "TBD"}{" "}
                    <span className="text-muted">v</span>{" "}
                    {m.team_b_id ? tm.get(m.team_b_id)?.team_name : "TBD"}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    #{m.match_order} · {m.round_name}
                    {m.court_id ? ` · ${courtName.get(m.court_id)}` : ""}
                    <MatchStatusBadge status={m.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="label">Results</h3>
        {decided.length === 0 ? (
          <p className="card p-6 text-center text-muted">No results yet.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {decided.map((m) => (
              <Link key={m.id} href={`/t/${slug}/match/${m.id}`}>
                {renderCard(m)}
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
