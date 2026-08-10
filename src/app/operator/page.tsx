import Link from "next/link";
import { db } from "@/lib/supabase";
import type { Tournament } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function OperatorIndex() {
  const { data } = await db()
    .from("tournaments")
    .select("*")
    .eq("kind", "tournament")
    .in("status", ["active", "draft", "completed"])
    .order("created_at", { ascending: false });
  const tournaments = (data ?? []) as Tournament[];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Select tournament</h1>
      <ul className="space-y-2">
        {tournaments.map((t) => (
          <li key={t.id}>
            <Link
              href={`/operator/tournaments/${t.id}/control`}
              className="card flex items-center justify-between hover:border-accent"
            >
              <span className="text-lg font-bold">{t.name}</span>
              <span className="badge bg-border text-muted">{t.status}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
