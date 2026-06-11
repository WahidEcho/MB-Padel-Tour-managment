import Link from "next/link";
import { currentRole } from "@/lib/auth";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function Home() {
  const role = await currentRole();
  const { data: tournaments } = await db()
    .from("tournaments")
    .select("name, slug, status")
    .eq("public_access_enabled", true)
    .in("status", ["active", "completed"])
    .order("created_at", { ascending: false })
    .limit(8);

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
        <div className="w-full max-w-md">
          <h2 className="label text-center">Public tournaments</h2>
          <ul className="mt-2 space-y-2">
            {tournaments.map((t) => (
              <li key={t.slug}>
                <Link href={`/t/${t.slug}`} className="card flex items-center justify-between hover:border-accent">
                  <span className="font-semibold">{t.name}</span>
                  <span className={`badge ${t.status === "active" ? "bg-accent/15 text-accent" : "bg-border text-muted"}`}>
                    {t.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
