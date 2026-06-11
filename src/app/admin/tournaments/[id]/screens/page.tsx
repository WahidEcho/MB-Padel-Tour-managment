import Link from "next/link";
import { notFound } from "next/navigation";
import { getTournament } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function ScreensPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const base = `/t/${tournament.slug}`;

  const LINKS: [string, string, string][] = [
    [`${base}/screen`, "TV display screen", "Full-screen display controlled by the screen operator. Open this on the TV browser."],
    [`${base}`, "Public overview (mobile)", "Groups, live matches, upcoming matches — share this link with players."],
    [`${base}/leaderboard`, "Public leaderboard", "Full standings tables."],
    [`${base}/live`, "Live matches", "All live scoreboards."],
    [`${base}/bracket`, "Bracket", "Knockout tree."],
    [`${base}/winner`, "Winner screen", "Champion, runner-up, third place."],
  ];

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Public screens &amp; links</h2>
      <p className="text-sm text-muted">
        All public links are read-only and auto-refresh. Control what the TV shows from the{" "}
        <Link href={`/operator/tournaments/${id}/control`} className="font-semibold text-accent">
          screen operator console
        </Link>.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {LINKS.map(([href, title, hint]) => (
          <li key={href} className="card space-y-1">
            <p className="font-bold">{title}</p>
            <p className="text-xs text-muted">{hint}</p>
            <p className="break-all font-mono text-xs text-accent">{href}</p>
            <a href={href} target="_blank" className="btn-secondary mt-1 text-xs">Open ↗</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
