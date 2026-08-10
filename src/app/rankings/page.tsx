import Link from "next/link";
import AutoRefresh from "@/components/AutoRefresh";
import RankingTable from "@/components/RankingTable";
import ShareButton from "@/components/ShareButton";
import { getRankingSnapshot, listPublicPlayers, listSeasons } from "@/lib/friendly/data";

export const dynamic = "force-dynamic";

/**
 * Public player rankings. Season or Lifetime scope; both are built from the
 * official ledger, so a session only appears here once it has been finalized.
 */
export default async function PublicRankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; season?: string; q?: string }>;
}) {
  const { scope: rawScope, season: rawSeason, q } = await searchParams;
  const seasons = await listSeasons();
  const active = seasons.find((s) => s.status === "active");

  const scope = rawScope === "lifetime" ? "lifetime" : "season";
  const seasonId = rawSeason ?? active?.id ?? null;

  const rows =
    scope === "lifetime"
      ? await getRankingSnapshot("lifetime", null)
      : seasonId
        ? await getRankingSnapshot("season", seasonId)
        : [];

  const names = await listPublicPlayers(rows.map((r) => r.player_profile_id));
  const filtered = q
    ? rows.filter((r) =>
        (names.get(r.player_profile_id)?.public_name ?? "").toLowerCase().includes(q.toLowerCase())
      )
    : rows;

  const seasonName = seasons.find((s) => s.id === seasonId)?.name;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-5 p-4">
      <AutoRefresh seconds={30} />

      <header className="space-y-1 text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">Move Beyond</p>
        <h1 className="text-3xl font-bold">Player rankings</h1>
        <p className="text-sm text-muted">
          {scope === "lifetime" ? "All results, all time" : (seasonName ?? "No season selected")}
        </p>
      </header>

      {/* Scope switch */}
      <div className="flex justify-center gap-1">
        <Link
          href={`/rankings?scope=season${seasonId ? `&season=${seasonId}` : ""}`}
          className={`badge ${scope === "season" ? "bg-accent/15 text-accent" : "bg-border text-muted"}`}
        >
          Season
        </Link>
        <Link
          href="/rankings?scope=lifetime"
          className={`badge ${scope === "lifetime" ? "bg-accent/15 text-accent" : "bg-border text-muted"}`}
        >
          Lifetime
        </Link>
      </div>

      <details className="card">
        <summary className="cursor-pointer text-sm font-semibold">Search &amp; filters</summary>
        <form className="mt-3 flex flex-wrap items-end gap-2" action="/rankings">
          <input type="hidden" name="scope" value={scope} />
          <div className="min-w-40 flex-1">
            <label className="label" htmlFor="rank-q">Player name</label>
            <input id="rank-q" name="q" defaultValue={q ?? ""} className="input" placeholder="e.g. Omar" />
          </div>
          {scope === "season" && seasons.length > 0 && (
            <div>
              <label className="label" htmlFor="rank-season">Season</label>
              <select id="rank-season" name="season" defaultValue={seasonId ?? ""} className="input w-auto">
                {seasons.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}
          <button className="btn-secondary text-sm">Apply</button>
        </form>
      </details>

      {filtered.length === 0 ? (
        <p className="card p-8 text-center text-muted">
          {rows.length === 0
            ? "No official results yet. Rankings appear once a session has been finalized."
            : "No players match that search."}
        </p>
      ) : (
        <RankingTable rows={filtered} names={names} />
      )}

      <div className="flex justify-center">
        <ShareButton
          path={`/rankings?scope=${scope}${seasonId && scope === "season" ? `&season=${seasonId}` : ""}`}
          text="Player rankings:"
        />
      </div>

      <p className="text-center text-xs text-muted">
        Ranked by points, then wins, then game difference, then games won. Tied players share a rank.
        &ldquo;P&rdquo; is matches played.
      </p>
    </main>
  );
}
