import Link from "next/link";
import { currentRole } from "@/lib/auth";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function Home() {
  const role = await currentRole();
  const { data: tournaments } = await db()
    .from("tournaments")
    .select("id, name, slug, status, sport")
    .eq("kind", "tournament")
    .eq("public_access_enabled", true)
    .in("status", ["active", "completed"])
    .order("created_at", { ascending: false })
    .limit(12);

  // Count live/paused matches per tournament for the "LIVE" pill.
  const ids = (tournaments ?? []).map((t) => t.id);
  const liveCount = new Map<string, number>();
  if (ids.length > 0) {
    const { data: liveMatches } = await db()
      .from("matches")
      .select("tournament_id")
      .in("tournament_id", ids)
      .in("status", ["live", "paused"]);
    for (const m of liveMatches ?? []) {
      liveCount.set(m.tournament_id, (liveCount.get(m.tournament_id) ?? 0) + 1);
    }
  }

  const sportMeta = (sport: string) =>
    sport === "chess" ? { icon: "♟", label: "Chess" } : { icon: "🎾", label: "Padel" };

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-accent">Move Beyond</p>
        <h1 className="mt-1 text-4xl font-bold">Tournament Management</h1>
        <p className="mt-2 text-muted">
          Live scoring, leaderboards, brackets, and event display screens.
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        {role ? (
          <>
            {(role === "admin" || role === "manager") && (
              <Link href="/admin/tournaments" className="btn-primary">Admin Console</Link>
            )}
            {role === "referee" && (
              <Link href="/referee" className="btn-primary">Referee Console</Link>
            )}
            {role === "operator" && (
              <Link href="/operator" className="btn-primary">Screen Operator</Link>
            )}
            <a href="/logout" className="btn-secondary">Log out ({role})</a>
          </>
        ) : (
          <Link href="/login" className="btn-primary">Staff Login</Link>
        )}
      </div>

      {tournaments && tournaments.length > 0 && (
        <div className="w-full max-w-5xl">
          <h2 className="label text-center">Live &amp; recent tournaments</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tournaments.map((t) => {
              const meta = sportMeta(t.sport);
              const lc = liveCount.get(t.id) ?? 0;
              return (
                <Link
                  key={t.slug}
                  href={`/t/${t.slug}`}
                  className="card group relative flex flex-col gap-3 overflow-hidden p-5 transition hover:border-accent hover:shadow-lg"
                >
                  <div className="flex items-center justify-between">
                    <span className="badge bg-border text-muted">
                      <span className="mr-1">{meta.icon}</span>{meta.label}
                    </span>
                    {lc > 0 ? (
                      <span className="badge bg-danger/15 text-danger">
                        <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-danger align-middle" />
                        {lc} LIVE
                      </span>
                    ) : (
                      <span className={`badge ${t.status === "active" ? "bg-accent/15 text-accent" : "bg-border text-muted"}`}>
                        {t.status}
                      </span>
                    )}
                  </div>
                  <span className="text-xl font-bold leading-tight">{t.name}</span>
                  <span className="mt-auto text-sm font-semibold text-accent group-hover:underline">
                    {lc > 0 ? "Watch live →" : "View tournament →"}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </main>
  );
}
