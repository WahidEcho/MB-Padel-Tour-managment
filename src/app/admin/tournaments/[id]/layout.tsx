import Link from "next/link";
import { notFound } from "next/navigation";
import { getTournament } from "@/lib/data";

export const dynamic = "force-dynamic";

const TABS = [
  ["", "Dashboard"],
  ["/teams", "Teams"],
  ["/groups", "Groups"],
  ["/matches", "Matches"],
  ["/leaderboard", "Leaderboard"],
  ["/bracket", "Bracket"],
  ["/screens", "Screens"],
  ["/settings", "Settings"],
] as const;

export default async function TournamentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">{tournament.name}</h1>
          <p className="text-xs text-muted">
            {tournament.status}
            {tournament.is_demo ? " · demo" : ""} · public: /t/{tournament.slug}
          </p>
        </div>
        <Link href={`/t/${tournament.slug}`} target="_blank" className="btn-secondary text-xs">
          Open public page ↗
        </Link>
      </div>
      <nav className="flex flex-wrap gap-1 border-b border-border pb-2 text-sm">
        {TABS.map(([path, label]) => (
          <Link
            key={path}
            href={`/admin/tournaments/${id}${path}`}
            className="rounded-lg px-3 py-1.5 font-semibold text-muted hover:bg-card hover:text-foreground"
          >
            {label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
