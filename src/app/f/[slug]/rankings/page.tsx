import Link from "next/link";
import { notFound } from "next/navigation";
import AutoRefresh from "@/components/AutoRefresh";
import RankingTable from "@/components/RankingTable";
import ShareButton from "@/components/ShareButton";
import { getRankingSnapshot, getSessionBySlug, listPublicPlayers } from "@/lib/friendly/data";

export const dynamic = "force-dynamic";

export default async function SessionRankingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSessionBySlug(slug);
  if (!session || session.visibility !== "public") notFound();

  const rows = await getRankingSnapshot("session", session.id);
  const names = await listPublicPlayers(rows.map((r) => r.player_profile_id));
  const official = session.status === "finalized";

  return (
    <main className="mx-auto w-full max-w-3xl space-y-5 p-4">
      <AutoRefresh seconds={8} />

      <header className="space-y-1 text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">Move Beyond</p>
        <h1 className="text-2xl font-bold">{session.name}</h1>
        <p className="text-sm text-muted">
          Session rankings ·{" "}
          {session.ranking_model === "games_won" ? "games won" : "points per win"}
        </p>
        {!official && rows.length > 0 && (
          <span className="badge bg-warning/15 text-warning">
            provisional — official once the organiser finalises
          </span>
        )}
      </header>

      <div className="flex justify-center gap-1 text-sm">
        <Link href={`/f/${slug}`} className="badge bg-border text-muted">Live</Link>
        <span className="badge bg-accent/15 text-accent">Rankings</span>
        <Link href="/rankings" className="badge bg-border text-muted">All players</Link>
      </div>

      <RankingTable rows={rows} names={names} />

      <div className="flex justify-center">
        <ShareButton path={`/f/${slug}/rankings`} text={`${session.name} — standings:`} />
      </div>

      <p className="text-center text-xs text-muted">
        Ranked by points, then wins, then game difference, then games won. Tied players share a rank.
      </p>
    </main>
  );
}
