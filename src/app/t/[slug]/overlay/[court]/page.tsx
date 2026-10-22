import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { defaultScreenSettings, getScreenSettings } from "@/lib/data";
import { MAIN_SCREEN } from "@/lib/screens";
import { buildLiveFeed } from "@/lib/tv/liveFeedServer";
import { overlayData } from "@/lib/stream/overlayServer";
import { OVERLAY_WATCHDOG, overlayOptions } from "@/lib/stream/overlay";
import BroadcastOverlay from "@/components/stream/BroadcastOverlay";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Broadcast overlay", robots: { index: false, follow: false } };

/**
 * A court's broadcast overlay: /t/<slug>/overlay/<court id or name>, added to
 * OBS (or vMix, Tricaster) as a 1920×1080 browser source over the camera feed.
 * Transparent everywhere but the score bug and the sponsor loop. Query switches:
 * `bug=0`, `footer=0`, `idle=0`, `scale=0.5…2` (src/lib/stream/overlay.ts).
 * Public data only, like the venue screens: the page is as public as the event.
 */
export default async function OverlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; court: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, court } = await params;
  const data = await overlayData(slug, court);
  if (!data) notFound();
  const query = await searchParams;
  if ("redirect" in data) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) qs.append(k, one);
    redirect(qs.size ? `${data.redirect}?${qs}` : data.redirect);
  }
  const options = overlayOptions(query);
  const screen = (await getScreenSettings(data.tournament.id, MAIN_SCREEN)) ?? defaultScreenSettings(data.tournament.id, MAIN_SCREEN);
  const initial = await buildLiveFeed(data.tournament.id, screen, data.tournament.updated_at);
  return (
    <>
      {/* The page itself is see-through: OBS composites it over the camera. */}
      <style>{"html,body{background:transparent!important;margin:0!important;overflow:hidden!important;min-height:0!important}"}</style>
      {/* The watchdog: plain ES5, so it runs in an old OBS browser (CEF) that cannot run the app's bundle. */}
      <script dangerouslySetInnerHTML={{ __html: OVERLAY_WATCHDOG }} />
      <BroadcastOverlay props={data.props} options={options} initial={initial} />
    </>
  );
}
