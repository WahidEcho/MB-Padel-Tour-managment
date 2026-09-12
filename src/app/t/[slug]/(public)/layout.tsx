import Link from "next/link";
import { notFound } from "next/navigation";
import { getTournamentBySlug } from "@/lib/data";
import { sizedImageSrc } from "@/lib/portrait";

export const dynamic = "force-dynamic";

export default async function PublicLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament || !tournament.public_access_enabled) notFound();

  // Chess has no group stage, so no group leaderboard tab.
  const NAV =
    tournament.sport === "chess"
      ? ([
          ["", "Overview"],
          ["/live", "Live"],
          ["/bracket", "Bracket"],
          ["/winner", "Winner"],
        ] as const)
      : ([
          ["", "Overview"],
          ["/leaderboard", "Leaderboard"],
          ["/live", "Live"],
          ["/bracket", "Bracket"],
          ["/winner", "Winner"],
        ] as const);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between">
          <div className="flex items-center gap-3">
            {tournament.branding_config.eventLogoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sizedImageSrc(tournament.branding_config.eventLogoUrl, 160) ?? ""} alt="" className="h-9" />
            )}
            <div>
              <h1 className="font-bold leading-tight">{tournament.name}</h1>
              <p className="text-[10px] uppercase tracking-widest text-muted">Powered by Move Beyond</p>
            </div>
          </div>
          <nav className="flex gap-1 text-xs font-semibold">
            {NAV.map(([path, label]) => (
              <Link key={path} href={`/t/${slug}${path}`} className="rounded-lg px-2 py-1 text-muted hover:bg-card hover:text-foreground">
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 p-4">{children}</main>
    </div>
  );
}
