import Link from "next/link";
import { notFound } from "next/navigation";
import { getTournament } from "@/lib/data";

export const dynamic = "force-dynamic";

const PADEL_TABS = [
  ["", "Dashboard"],
  ["/teams", "Teams"],
  ["/groups", "Groups"],
  ["/matches", "Matches"],
  ["/leaderboard", "Leaderboard"],
  ["/bracket", "Bracket"],
  ["/screens", "Screens"],
  ["/settings", "Settings"],
] as const;

// A tennis team competition: nations instead of teams, and ties of rubbers.
const TIE_TABS = [
  ["", "Dashboard"],
  ["/nations", "Nations"],
  ["/groups", "Groups"],
  ["/ties", "Ties"],
  ["/leaderboard", "Leaderboard"],
  ["/matches", "Rubbers"],
  ["/screens", "Screens"],
  ["/replay", "Replay"],
  ["/settings", "Settings"],
] as const;

// Chess is a pure knockout — no group stage or group leaderboard.
const CHESS_TABS = [
  ["", "Dashboard"],
  ["/teams", "Players"],
  ["/bracket", "Bracket"],
  ["/matches", "Games"],
  ["/screens", "Screens"],
  ["/settings", "Settings"],
] as const;

// What a friendly session shares with the tournament tools: its walls, its
// branding and courts, and releasing a dead tablet's scoring lock.
const SESSION_TABS = [
  ["/screens", "Screens"],
  ["/settings", "Courts & branding"],
  ["/matches", "Scoring locks"],
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
  // A friendly session's hidden row shares only a few tools with the tournament
  // pages. A layout cannot see which tab is open, so each other tab's page shows
  // a notice too; this just stops offering them.
  const isSessionRow = tournament.kind !== "tournament";
  const TABS = isSessionRow
    ? SESSION_TABS
    : tournament.sport === "chess"
      ? CHESS_TABS
      : tournament.format_config?.ties
        ? // Replaying results is for demo events only.
          TIE_TABS.filter(([href]) => href !== "/replay" || tournament.is_demo)
        : PADEL_TABS;

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
        <div className="flex gap-2">
          <a href={`/api/tournaments/${id}/export`} className="btn-secondary text-xs">
            ⬇ Export Excel
          </a>
          {!isSessionRow && (
            <Link href={`/admin/tournaments/${id}/clone`} className="btn-secondary text-xs">
              Clone
            </Link>
          )}
          <Link href={`/t/${tournament.slug}`} target="_blank" className="btn-secondary text-xs">
            Public page ↗
          </Link>
        </div>
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
