import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { defaultScreenSettings, getScreenSettings } from "@/lib/data";
import { MAIN_SCREEN } from "@/lib/screens";
import { buildLiveFeed } from "@/lib/tv/liveFeedServer";
import { overlayData } from "@/lib/stream/overlayServer";
import { OVERLAY_WATCHDOG, overlayOptions } from "@/lib/stream/overlay";
import BroadcastOverlay from "@/components/stream/BroadcastOverlay";
import { liveVideoConfig } from "@/lib/stream/liveVideo";
import { youtubeEmbedUrl } from "@/lib/stream/youtube";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Broadcast overlay", robots: { index: false, follow: false } };

/**
 * A court's broadcast overlay: /t/<slug>/overlay/<court id or name>, added to
 * OBS (or vMix, Tricaster) as a 1920×1080 browser source over the camera feed.
 * Transparent everywhere but the score bug and the sponsor loop. Query switches:
 * `bug=0`, `footer=0`, `idle=0`, `scale=0.5…2` (src/lib/stream/overlay.ts).
 * `video=1` is the watching mode for people, not OBS: the court's YouTube live video
 * (Admin → Live stream) fills the page and the overlay above it is drawn over it, live.
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
  const videoMode = [query.video].flat()[0] === "1";
  if (videoMode) return <WatchWithScore slug={slug} courtId={data.props.court.id} courtName={data.props.court.name} query={query} youtubeId={liveVideoConfig(data.tournament.branding_config).courts[data.props.court.id]?.youtubeId ?? null} />;
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

/**
 * `?video=1`: the court's live video with our scoreboard over it, for watching in a browser or
 * sharing. The board is the plain overlay page (same URL without `video`, so OBS keeps its link),
 * drawn at 1920×1080 and scaled to the video box: 0.92× (owner, 23 Oct 2026: 20% smaller than the
 * first 1.15×), moved left onto a stream's own score bar, with a frosted patch over the rest of
 * that bar (about x 18–690, y 912–1032 of the frame) so none of it shows. Live, no delay.
 */
function WatchWithScore({ slug, courtId, courtName, query, youtubeId }: { slug: string; courtId: string; courtName: string; query: Record<string, string | string[] | undefined>; youtubeId: string | null }) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (k !== "video") for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, one);
  if (!q.has("scale")) q.set("scale", "0.92");
  if (!q.has("footer")) q.set("footer", "0");
  const board = `/t/${encodeURIComponent(slug)}/overlay/${encodeURIComponent(courtId)}?${q.toString()}`;
  return (
    <>
      <style>{`html,body{background:#000!important;margin:0!important;height:100%;overflow:hidden!important}
        .wbox{position:fixed;inset:0;margin:auto;width:min(100vw,calc(100vh*16/9));height:min(100vh,calc(100vw*9/16));overflow:hidden;background:#000}
        .wbox iframe{border:0;position:absolute;left:0;top:0}
        .wlayer{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0;pointer-events:none}
        .wpatch{position:absolute;left:14px;top:906px;width:682px;height:130px;border-radius:18px;background:rgba(12,22,70,.55);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}
        .wmsg{position:absolute;inset:0;display:grid;place-items:center;color:#9aa5c6;font:600 18px system-ui,sans-serif;text-align:center;padding:24px}`}</style>
      <div className="wbox" id="wbox" data-testid="overlay-watch" data-court={courtName}>
        {youtubeId ? (
          <iframe
            src={youtubeEmbedUrl(youtubeId, { autoplay: true, mute: true })}
            title={`Live video, ${courtName}`}
            style={{ width: "100%", height: "100%" }}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <div className="wmsg">No live video is set for {courtName} (Admin → Live stream).</div>
        )}
        {/* Board and patch share one 1920×1080 layer scaled to the video; the board sits 30 px left of its OBS place. */}
        <div className="wlayer" id="wlayer">
          {youtubeId ? <div className="wpatch" /> : null}
          <iframe id="wboard" src={board} title={`Score, ${courtName}`} aria-hidden tabIndex={-1} style={{ width: 1920, height: 1080, transform: "translateX(-30px)", pointerEvents: "none", background: "transparent" }} />
        </div>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html:
            "(function(){var b=document.getElementById('wbox'),l=document.getElementById('wlayer');function fit(){if(b&&l)l.style.transform='scale('+(b.clientWidth/1920)+')';}fit();window.addEventListener('resize',fit);})();",
        }}
      />
    </>
  );
}
