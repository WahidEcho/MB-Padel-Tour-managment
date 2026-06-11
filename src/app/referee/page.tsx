import Link from "next/link";
import { db } from "@/lib/supabase";
import type { Tournament } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function RefereeTournaments() {
  const { data } = await db()
    .from("tournaments")
    .select("*")
    .in("status", ["active", "draft"])
    .order("status", { ascending: true })
    .order("created_at", { ascending: false });
  const tournaments = (data ?? []) as Tournament[];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Select tournament</h1>
      <ul className="space-y-2">
        {tournaments.map((t) => (
          <li key={t.id}>
            <Link
              href={`/referee/tournaments/${t.id}/matches`}
              className="card flex items-center justify-between hover:border-accent"
            >
              <span className="text-lg font-bold">{t.name}</span>
              <span className={`badge ${t.status === "active" ? "bg-success/15 text-success" : "bg-border text-muted"}`}>
                {t.status}
              </span>
            </Link>
          </li>
        ))}
        {tournaments.length === 0 && <p className="card p-8 text-center text-muted">No tournaments available.</p>}
      </ul>
    </div>
  );
}
