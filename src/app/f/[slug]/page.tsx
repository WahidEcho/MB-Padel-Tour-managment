import Link from "next/link";
import { notFound } from "next/navigation";
import AutoRefresh from "@/components/AutoRefresh";
import SponsorMarquee from "@/components/SponsorMarquee";
import PresenceBeat from "@/components/PresenceBeat";
import { getCourts, getMatches, getTeams, getTournament, teamMap } from "@/lib/data";
import { getRankingSnapshot, getSessionBySlug, listPublicPlayers } from "@/lib/friendly/data";

export const dynamic = "force-dynamic";

/**
 * Public session page — live courts, what's next, and the running standings.
 * No login. Only public names and ranking data are exposed; mobile numbers
 * never leave the server.
 */
export default async function SessionPublicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSessionBySlug(slug);
  if (!session || session.visibility !== "public") notFound();

  const [matches, teams, courts, ranking, tournament] = await Promise.all([
    getMatches(session.tournament_id),
    getTeams(session.tournament_id),
    getCourts(session.tournament_id),
    getRankingSnapshot("session", session.id),
    getTournament(session.tournament_id),
  ]);
  const sponsors = tournament?.branding_config?.sponsorLogoUrls ?? [];

  const tm = teamMap(teams);
  const courtName = new Map(courts.map((c) => [c.id, c.court_name]));
  const friendly = matches.filter((m) => m.stage === "friendly");
  const live = friendly.filter((m) => ["live", "paused"].includes(m.status));
  const upcoming = friendly.filter((m) => m.status === "scheduled").slice(0, 6);

  const names = await listPublicPlayers(ranking.map((r) => r.player_profile_id));
  const label = (id: string | null) => (id ? (tm.get(id)?.team_name ?? "?") : "TBD");

  const modelLabel = session.ranking_model === "games_won" ? "games won" : "points per win";

  return (
    <main className="mx-auto w-full max-w-3xl space-y-5 p-4">
      <AutoRefresh seconds={8} />

      <header className="space-y-1 text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">Move Beyond</p>
        <h1 className="flex items-center justify-center gap-2 text-3xl font-bold">
          {session.name}
          <PresenceBeat slug={slug} page="session" kind="session" />
        </h1>
        <p className="text-sm text-muted">
          {session.pairing_mode} · scored on {modelLabel}
          {session.starts_at
            ? ` · ${new Date(session.starts_at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`
            : ""}
        </p>
        {session.status === "open" && (
          <Link href={`/f/${slug}/register`} className="btn-primary mt-2 inline-block text-sm">
            Register for this session
          </Link>
        )}
      </header>

      {live.length > 0 && (
        <section className="space-y-2">
          <h2 className="label">On court now</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {live.map((m) => (
              <div key={m.id} className="card border-success/40">
                <p className="text-xs text-muted">
                  {courtName.get(m.court_id ?? "") ?? "Court"} · {m.round_name}
                </p>
                <p className="font-bold">{label(m.team_a_id)}</p>
                <p className="text-sm text-muted">v {label(m.team_b_id)}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="space-y-2">
          <h2 className="label">Up next</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {upcoming.map((m) => (
              <div key={m.id} className="card">
                <p className="text-xs text-muted">
                  {courtName.get(m.court_id ?? "") ?? "Court"} · {m.round_name}
                </p>
                <p className="text-sm font-semibold">{label(m.team_a_id)}</p>
                <p className="text-xs text-muted">v {label(m.team_b_id)}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="label">Standings</h2>
          {session.status !== "finalized" && ranking.length > 0 && (
            <span className="badge bg-warning/15 text-warning">provisional</span>
          )}
        </div>
        {ranking.length === 0 ? (
          <p className="card p-6 text-center text-muted">
            Standings appear once the first match is finished.
          </p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted">
                  <th className="py-1">#</th>
                  <th className="py-1">Player</th>
                  <th className="py-1 text-right">Pts</th>
                  <th className="py-1 text-right">P</th>
                  <th className="py-1 text-right">W</th>
                  <th className="py-1 text-right">Diff</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((r) => (
                  <tr key={r.player_profile_id} className="border-t border-border">
                    <td className="py-1.5 font-bold">{r.rank}</td>
                    <td className="py-1.5">
                      {names.get(r.player_profile_id)?.public_name ?? "—"}
                      {r.active_streak >= 2 && (
                        <span className="badge ml-1 bg-accent/15 text-accent">🔥 {r.active_streak}</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right font-bold">{r.points}</td>
                    <td className="py-1.5 text-right text-muted">{r.matches_played}</td>
                    <td className="py-1.5 text-right text-muted">{r.wins}</td>
                    <td className="py-1.5 text-right text-muted">
                      {r.game_diff > 0 ? `+${r.game_diff}` : r.game_diff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted">
          Ranked by points, then wins, then game difference. Tied players share a rank.
          {" "}&ldquo;P&rdquo; is matches played — not everyone plays the same number.
        </p>
      </section>

      <SponsorMarquee logos={sponsors} />
    </main>
  );
}
