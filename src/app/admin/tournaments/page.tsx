import Link from "next/link";
import { db } from "@/lib/supabase";
import type { Tournament } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-border text-muted",
  active: "bg-success/15 text-success",
  completed: "bg-accent/15 text-accent",
  archived: "bg-border text-muted",
};

export default async function TournamentsPage() {
  const { data } = await db().from("tournaments").select("*").order("created_at", { ascending: false });
  const tournaments = (data ?? []) as Tournament[];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tournaments</h1>
        <Link href="/admin/tournaments/new" className="btn-primary">+ New Tournament</Link>
      </div>

      {tournaments.length === 0 ? (
        <div className="card p-10 text-center text-muted">
          No tournaments yet. Create your first one to get started.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {tournaments.map((t) => (
            <li key={t.id} className="card space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <Link href={`/admin/tournaments/${t.id}`} className="text-lg font-bold hover:text-accent">
                    {t.name}
                  </Link>
                  <p className="text-xs text-muted">/t/{t.slug}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`badge ${STATUS_BADGE[t.status]}`}>{t.status}</span>
                  {t.is_demo && <span className="badge bg-warning/15 text-warning">demo</span>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/admin/tournaments/${t.id}`} className="btn-secondary text-xs">Open</Link>
                <Link href={`/admin/tournaments/${t.id}/clone`} className="btn-secondary text-xs">Clone Tournament</Link>
                <Link href={`/t/${t.slug}`} className="btn-secondary text-xs" target="_blank">Public page</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
