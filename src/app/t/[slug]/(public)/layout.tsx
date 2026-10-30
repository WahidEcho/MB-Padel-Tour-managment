import Link from "next/link";
import { notFound } from "next/navigation";
import { getTournamentBySlug } from "@/lib/data";
import { sizedImageSrc } from "@/lib/portrait";
import PresenceBeatForPath from "@/components/PresenceBeatForPath";
import SponsorMarquee from "@/components/SponsorMarquee";
import SponsorWatermark from "@/components/broadcast/SponsorWatermark";
import EventBackdrop from "@/components/broadcast/EventBackdrop";
import { backgroundFor } from "@/lib/background";
import { resolveSponsors, sponsorStyle, watermarkSponsor } from "@/lib/sponsors";
import WatchOnScreenMenu from "@/components/WatchOnScreenMenu";
import { watchTargets } from "@/lib/watch";
import { hasPublicVenue } from "@/lib/venue/server";
import PlayNotice from "@/components/PlayNotice";
import { hasPublicEventInfo } from "@/lib/eventInfo/server";
import { scoreDelayNotice, scoreDelaySeconds } from "@/lib/live/delay";

// Rendered at most every 10s and shared by every visitor: at the venue a crowd
// refreshing this page reads one cached copy instead of the database each time.
export const revalidate = 10;

// No tournament is built ahead of time; each is rendered on its first visit and
// then cached for the revalidate window above.
export function generateStaticParams() {
  return [];
}

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
          ["/matches", "Matches"],
          ["/bracket", "Bracket"],
          ["/winner", "Winner"],
        ] as const)
      : tournament.format_config?.ties
        ? ([
            ["", "Overview"],
            ["/ties", "Ties"],
            ["/leaderboard", "Leaderboard"],
            ["/live", "Live"],
            ["/matches", "Matches"],
            ["/winner", "Winner"],
          ] as const)
        : ([
          ["", "Overview"],
          ["/leaderboard", "Leaderboard"],
          ["/live", "Live"],
          ["/matches", "Matches"],
          ["/bracket", "Bracket"],
          ["/winner", "Winner"],
        ] as const);

  const { main, footer } = resolveSponsors(tournament.branding_config);
  const band = sponsorStyle(tournament.branding_config);
  // The venue screens anyone here may open, on every public page.
  const watch = await watchTargets(tournament.id);
  // The venue map, when the organiser has published one (its own full-screen page).
  const hasMap = await hasPublicVenue(slug);
  // The event info for fans, once the organiser has published it.
  const hasInfo = await hasPublicEventInfo(slug);
  const backdrop = backgroundFor(tournament.branding_config, "public", "light");
  // The audience delay (Admin → In the app → Score delay): say so while it is on.
  const delayNote = scoreDelayNotice(scoreDelaySeconds(tournament.branding_config));

  // These pages are light: the light-surface logo first (eventLogoUrl is often the white one for dark TVs).
  const headerLogo = tournament.branding_config.eventLogoLightUrl || tournament.branding_config.eventLogoUrl;

  return (
    <div className={`relative isolate flex min-h-screen flex-col${backdrop ? " bc-page-backdrop" : ""}`}>
      {/* The main sponsor glows behind the public pages too, fixed to the
          viewport so it stays put while the standings scroll. */}
      {/* The event background, only when the organiser chose it for these pages. */}
      {backdrop && <EventBackdrop background={backdrop} variant="page" />}
      {main?.showOnDashboard !== false && (
        <SponsorWatermark sponsor={watermarkSponsor(main)} surface="dashboard" backgroundHex="#ffffff" variant="page" />
      )}
      {/* Above the content, not level with it: the Watch menu drops out of the
          header, and at the same z-index the page below painted straight over it. */}
      <header className={`relative z-30 border-b border-border px-4 py-2 sm:py-3${backdrop ? " bg-background/85" : ""}`}>
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          <div className="flex w-full min-w-0 items-center gap-2.5 sm:w-auto sm:gap-3">
            {headerLogo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sizedImageSrc(headerLogo, 320) ?? ""} alt="" className="h-7 w-auto max-w-[42%] shrink-0 object-contain sm:h-9" />
            )}
            <div className="min-w-0">
              <h1 className="line-clamp-2 text-sm font-bold leading-snug sm:text-base">{tournament.name}</h1>
              {tournament.branding_config.hidePoweredBy !== true && (
                <p className="text-[10px] uppercase tracking-widest text-muted">Powered by Move Beyond</p>
              )}
            </div>
          </div>
          {/* On a phone the nav is its own row and scrolls sideways; Watch stays outside
              the scroller so its menu is never clipped. */}
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <nav className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto whitespace-nowrap px-1 text-xs font-semibold [scrollbar-width:none] sm:flex-wrap sm:overflow-visible [&::-webkit-scrollbar]:hidden">
              {[...NAV, ...(hasMap ? [["/map", "Map"] as const] : []), ...(hasInfo ? [["/info", "Info"] as const] : [])].map(([path, label]) => (
                <Link key={path} href={`/t/${slug}${path}`} className="rounded-lg px-2 py-1 text-muted hover:bg-card hover:text-foreground">
                  {label}
                </Link>
              ))}
            </nav>
            <WatchOnScreenMenu slug={slug} screens={watch.screens} courts={watch.courts} />
          </div>
        </div>
      </header>
      {/* Rain delay / play suspended / resumed and the latest major announcement. */}
      <PlayNotice tournament={tournament} />
      {delayNote && (
        <p className="relative z-20 mx-auto w-full max-w-7xl px-4 pt-2 text-xs text-muted" data-testid="score-delay-note">
          {delayNote}
        </p>
      )}
      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 p-4">{children}</main>
      {/* Reports this browser and shows how many others are here, out of the header
          (it crowded the title on phones). The page is read from the path, so one
          mount covers every tab. */}
      <div className="relative z-10 mx-auto flex w-full max-w-7xl justify-end px-4 pb-2 text-xs">
        <PresenceBeatForPath slug={slug} />
      </div>
      {footer.length > 0 && (
        <footer className="relative z-10 mx-auto w-full max-w-7xl px-4 pb-4">
          <SponsorMarquee logos={footer.map((sp) => sp.logoUrl)} chips={band.chips} uniform={band.uniform} />
        </footer>
      )}
    </div>
  );
}
