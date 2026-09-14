import Link from "next/link";
import { notFound } from "next/navigation";
import { getTournamentBySlug } from "@/lib/data";
import { sizedImageSrc } from "@/lib/portrait";
import PresenceBeatForPath from "@/components/PresenceBeatForPath";
import SponsorMarquee from "@/components/SponsorMarquee";
import SponsorWatermark from "@/components/broadcast/SponsorWatermark";
import EventBackdrop from "@/components/broadcast/EventBackdrop";
import { backgroundFor } from "@/lib/background";
import { resolveSponsors } from "@/lib/sponsors";

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

  const { main, footer } = resolveSponsors(tournament.branding_config);
  const backdrop = backgroundFor(tournament.branding_config, "public");

  return (
    <div className={`relative isolate flex min-h-screen flex-col${backdrop ? " bc-page-backdrop" : ""}`}>
      {/* The main sponsor glows behind the public pages too, fixed to the
          viewport so it stays put while the standings scroll. */}
      {/* The event background, only when the organiser chose it for these pages. */}
      {backdrop && <EventBackdrop background={backdrop} variant="page" />}
      {main?.showOnDashboard !== false && (
        <SponsorWatermark sponsor={main} surface="dashboard" backgroundHex="#ffffff" variant="page" />
      )}
      <header className={`relative z-10 border-b border-border px-4 py-3${backdrop ? " bg-background/85" : ""}`}>
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between">
          <div className="flex items-center gap-3">
            {tournament.branding_config.eventLogoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sizedImageSrc(tournament.branding_config.eventLogoUrl, 160) ?? ""} alt="" className="h-9" />
            )}
            <div>
              <h1 className="flex items-center gap-2 font-bold leading-tight">
                {tournament.name}
                {/* Reports this browser and shows how many others are here. The
                    page is read from the path, so one mount covers every tab. */}
                <PresenceBeatForPath slug={slug} />
              </h1>
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
      <main className="relative z-10 mx-auto w-full max-w-5xl flex-1 p-4">{children}</main>
      {footer.length > 0 && (
        <footer className="relative z-10 mx-auto w-full max-w-5xl px-4 pb-4">
          <SponsorMarquee logos={footer.map((sp) => sp.logoUrl)} />
        </footer>
      )}
    </div>
  );
}
