import Link from "next/link";
import RankingTable from "@/components/RankingTable";
import { requirePermission } from "@/lib/guard";
import { revalidatePath } from "next/cache";
import { getRankingSnapshot, listPublicPlayers, listSeasons } from "@/lib/friendly/data";
import { recalcSeasonAndLifetime } from "@/lib/friendly/ops";

export const dynamic = "force-dynamic";

async function recalcAction(formData: FormData) {
  "use server";
  await requirePermission("manage_sessions");
  const seasonId = String(formData.get("season_id") ?? "") || null;
  await recalcSeasonAndLifetime(seasonId);
  revalidatePath("/admin/rankings");
}

export default async function AdminRankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; season?: string }>;
}) {
  const { scope: rawScope, season: rawSeason } = await searchParams;
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Rankings</h1>
        <form action={recalcAction}>
          <input type="hidden" name="season_id" value={seasonId ?? ""} />
          <button className="btn-secondary text-xs">Recalculate now</button>
        </form>
      </div>

      <p className="text-xs text-muted">
        Season and Lifetime rankings count <b>official</b> results only — a session contributes once it
        has been finalized. Order: points → wins → game difference → games won; ties share a rank.
      </p>

      <div className="flex flex-wrap gap-1">
        <Link
          href={`/admin/rankings?scope=season${seasonId ? `&season=${seasonId}` : ""}`}
          className={`badge ${scope === "season" ? "bg-accent/15 text-accent" : "bg-border text-muted"}`}
        >
          Season
        </Link>
        <Link
          href="/admin/rankings?scope=lifetime"
          className={`badge ${scope === "lifetime" ? "bg-accent/15 text-accent" : "bg-border text-muted"}`}
        >
          Lifetime
        </Link>
        <Link href="/rankings" target="_blank" className="badge bg-border text-muted">
          Public page ↗
        </Link>
      </div>

      {scope === "season" && seasons.length > 1 && (
        <form className="flex items-end gap-2" action="/admin/rankings">
          <input type="hidden" name="scope" value="season" />
          <div>
            <label className="label" htmlFor="admin-season">Season</label>
            <select id="admin-season" name="season" defaultValue={seasonId ?? ""} className="input w-auto">
              {seasons.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <button className="btn-secondary text-sm">View</button>
        </form>
      )}

      {rows.length === 0 ? (
        <div className="card space-y-2 p-8 text-center text-muted">
          <p className="font-semibold text-foreground">Nothing official yet</p>
          <p className="text-sm">
            Finalize a session on its page to publish its points into the Season and Lifetime tables.
          </p>
        </div>
      ) : (
        <RankingTable rows={rows} names={names} />
      )}
    </div>
  );
}
