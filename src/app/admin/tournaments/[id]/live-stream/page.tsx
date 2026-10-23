import { notFound } from "next/navigation";
import { requireTournamentPage } from "@/lib/guard";
import { getCourts, getTournament } from "@/lib/data";
import { siteUrl } from "@/lib/messaging/links";
import { liveVideoConfig } from "@/lib/stream/liveVideo";
import { youtubeWatchUrl } from "@/lib/stream/youtube";
import StateForm from "@/components/StateForm";
import { saveLiveVideo, saveOverlayTitle } from "./actions";
import { CopyField, OverlayPreview } from "./LiveStreamClient";

export const dynamic = "force-dynamic";

/**
 * Live stream: per court, the YouTube live video viewers watch in the app and on
 * the website, and the broadcast overlay Move Beyond's OBS adds over the camera.
 * Which courts are streamed is the organiser's choice here; nothing is fixed in
 * code. Operator guide: docs/live-stream.md.
 */
export default async function LiveStreamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireTournamentPage(id, ["admin", "manager"], `/admin/tournaments/${id}/live-stream`);
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const courts = (await getCourts(id)).filter((c) => c.is_active !== false);
  const cfg = liveVideoConfig(tournament.branding_config);
  const base = `${siteUrl()}/t/${tournament.slug}/overlay`;
  const relBase = `/t/${tournament.slug}/overlay`;
  const streamed = courts.filter((c) => cfg.courts[c.id]?.on).length;

  return (
    <div className="space-y-4" data-testid="live-stream">
      <section className="card space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="font-bold">Live video — {tournament.name}</h2>
            <p className="text-sm text-muted">
              One YouTube live video per court. While a court&rsquo;s video is on, its live match shows a{" "}
              <span className="font-semibold text-danger">● LIVE VIDEO</span> badge and plays the video inside the Move Score app (match page and the live
              courts on Discover) and on this event&rsquo;s match pages. Off, viewers see nothing of it.
            </p>
          </div>
          <span className="badge bg-accent/15 text-accent">{streamed ? `${streamed} court${streamed > 1 ? "s" : ""} streamed` : "No court streamed"}</span>
        </div>
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="stream-delay-note">
          <p className="font-semibold">Stream delay</p>
          <p className="text-muted">
            Scores reach the overlay about 1–2 s after the umpire&rsquo;s tap, so in OBS the bug sits on the picture almost in step (add a Render Delay
            filter of a second or two on the camera if the crew&rsquo;s feed is ahead). Viewers then watch YouTube about 5–10 s behind real time with
            &ldquo;Low latency&rdquo; (up to 30 s on &ldquo;Normal&rdquo;), so the live score in the app runs ahead of the video. Enter the delay you see in
            rehearsal below: viewers are told the video runs that far behind. In YouTube Studio, set each live video to <b>Allow embedding</b>, or the
            app and website can only offer &ldquo;Open on YouTube&rdquo;.
          </p>
        </div>
      </section>

      <section className="card space-y-2">
        <p className="label">Overlay title</p>
        <StateForm action={saveOverlayTitle} className="flex flex-wrap items-end gap-2" testId="overlay-title-form">
          <input type="hidden" name="tournament_id" value={id} />
          <input name="overlay_title" defaultValue={cfg.overlayTitle} placeholder={tournament.name} maxLength={60} className="input max-w-md flex-1" data-testid="overlay-title" />
          <button className="btn-secondary">Save title</button>
        </StateForm>
        <p className="text-xs text-muted">The first words of the score bug&rsquo;s header strip, e.g. DAVIS CUP JUNIORS · EGY 1–0 USA · S2. Empty: the tournament&rsquo;s name.</p>
      </section>

      {courts.length === 0 && <p className="card text-sm text-muted">This tournament has no courts yet. Add them in Settings.</p>}

      <div className="grid gap-4 xl:grid-cols-2">
        {courts.map((court) => {
          const v = cfg.courts[court.id];
          const overlayUrl = `${base}/${court.id}`;
          return (
            <section key={court.id} className="card space-y-3" data-testid={`live-court-${court.court_name}`}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-bold">{court.court_name}</h3>
                {v?.on ? (
                  <span className="badge bg-danger/15 font-bold text-danger" data-testid="court-live-on">● LIVE VIDEO ON</span>
                ) : (
                  <span className="badge bg-card text-muted">{v ? "Video set · off" : "No video"}</span>
                )}
              </div>

              <StateForm action={saveLiveVideo} className="space-y-2" testId={`live-form-${court.court_name}`}>
                <input type="hidden" name="tournament_id" value={id} />
                <input type="hidden" name="court_id" value={court.id} />
                <label className="block">
                  <span className="label">YouTube live URL</span>
                  <input
                    name="youtube_url"
                    defaultValue={v ? youtubeWatchUrl(v.youtubeId) : ""}
                    placeholder="https://youtube.com/live/… or https://youtu.be/…"
                    className="input font-mono text-xs"
                    data-testid="youtube-url"
                  />
                </label>
                <div className="flex flex-wrap items-end gap-4">
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" name="on" defaultChecked={v?.on ?? false} className="switch" data-testid="live-on" />
                    Show to viewers
                  </label>
                  <label className="block">
                    <span className="label">Video delay (s, optional)</span>
                    <input name="delay_seconds" type="number" min={0} max={120} step={1} defaultValue={v?.delaySeconds ?? ""} className="input w-28" />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-primary" name="intent" value="save" data-testid="live-save">Save</button>
                  {v && (
                    <button className="btn-secondary" name="intent" value="remove">Remove video</button>
                  )}
                  {v && (
                    <a href={youtubeWatchUrl(v.youtubeId)} target="_blank" rel="noreferrer" className="btn-secondary text-xs">
                      Open on YouTube ↗
                    </a>
                  )}
                </div>
                {v && <p className="text-xs text-muted">Video id <code>{v.youtubeId}</code>{v.updatedAt ? ` · saved ${new Date(v.updatedAt).toLocaleString("en-GB", { timeZone: tournament.timezone || "Africa/Cairo" })}` : ""}</p>}
              </StateForm>

              <div className="space-y-2 border-t border-border pt-3">
                {v && (
                  <>
                    <CopyField label="Watch link: live video with the Move Score board over it (share this one)" value={`${overlayUrl}?video=1`} testId={`watch-url-${court.court_name}`} />
                    <a href={`${relBase}/${court.id}?video=1`} target="_blank" rel="noreferrer" className="btn-secondary text-xs">Open the watch link ↗</a>
                  </>
                )}
                <CopyField label="OBS overlay URL (browser source, 1920 × 1080)" value={overlayUrl} testId={`overlay-url-${court.court_name}`} />
                <p className="text-xs text-muted">
                  Score bug only: <code>?footer=0</code> · sponsors only: <code>?bug=0</code> · bigger or smaller: <code>?scale=1.2</code>. The link
                  uses the court&rsquo;s id, so renaming the court keeps OBS working. It is see-through on purpose (blank in a normal
                  browser); to watch, use the watch link above.
                </p>
                <OverlayPreview src={`${relBase}/${court.id}`} title={`Overlay preview, ${court.court_name}`} />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
