"use client";

/* eslint-disable @next/next/no-img-element -- YouTube's own poster still, as it serves it */
import { useEffect, useRef, useState } from "react";
import { delayNote } from "@/lib/stream/liveVideo";
import { youtubeEmbedUrl, youtubeErrorKind, youtubeThumbnailUrl, youtubeWatchUrl } from "@/lib/stream/youtube";
import type { MLiveVideo } from "@/lib/mobile/contract";

/** The bits of the YouTube IFrame API this player uses. */
interface YTPlayer {
  destroy(): void;
}
interface YTNamespace {
  Player: new (el: HTMLIFrameElement, opts: { events: { onError?: (e: { data: number }) => void; onStateChange?: (e: { data: number }) => void } }) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace | null> | null = null;
/** Loads the IFrame API once per page. Null when it cannot (blocked, offline): the plain embed still plays. */
function loadApi(): Promise<YTNamespace | null> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve) => {
    const done = () => resolve(window.YT?.Player ? window.YT : null);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      done();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.async = true;
    tag.onerror = () => resolve(null);
    document.head.appendChild(tag);
    setTimeout(done, 10_000);
  });
  return apiPromise;
}

type Problem = "embedding_disabled" | "unavailable" | "error" | "ended" | null;

const PROBLEM_TEXT: Record<Exclude<Problem, null>, string> = {
  embedding_disabled: "This video can only be watched on YouTube.",
  unavailable: "The live video is not available right now. It may not have started yet.",
  error: "The video could not be played here.",
  ended: "The live stream has ended.",
};

/**
 * A court's YouTube live video inside the page (no trip to YouTube). A poster
 * first, so a match page that refreshes every few seconds costs nothing until
 * someone presses play; then the nocookie embed. A stream not started yet shows
 * YouTube's own waiting screen; an ended one, embedding switched off or a
 * missing video falls back to "Open on YouTube", which is always offered below.
 */
export default function YouTubeLivePlayer({ video, autoStart = false }: { video: MLiveVideo; autoStart?: boolean }) {
  const [playing, setPlaying] = useState(autoStart);
  const [problem, setProblem] = useState<Problem>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const watch = youtubeWatchUrl(video.youtubeId);

  useEffect(() => {
    if (!playing || !frame.current) return;
    let player: YTPlayer | null = null;
    let cancelled = false;
    void loadApi().then((YT) => {
      if (cancelled || !YT || !frame.current) return;
      player = new YT.Player(frame.current, {
        events: {
          onError: (e) => setProblem(youtubeErrorKind(e.data)),
          // 0 = ended. A live video that ends stops here rather than looping its recording.
          onStateChange: (e) => {
            if (e.data === 0) setProblem("ended");
            else if (e.data === 1) setProblem(null);
          },
        },
      });
    });
    return () => {
      cancelled = true;
      try {
        player?.destroy();
      } catch {
        // The iframe is already gone with the component.
      }
    };
  }, [playing, video.youtubeId]);

  const origin = typeof window === "undefined" ? undefined : window.location.origin;
  return (
    <section className="space-y-2" data-testid="live-video-player" data-video={video.youtubeId}>
      <div className="relative w-full overflow-hidden rounded-2xl bg-black" style={{ aspectRatio: "16 / 9" }}>
        {problem ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-white" data-testid="live-video-fallback">
            <img src={youtubeThumbnailUrl(video.youtubeId)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25" />
            <p className="relative text-base font-semibold">{PROBLEM_TEXT[problem]}</p>
            <a href={watch} target="_blank" rel="noreferrer" className="relative rounded-full bg-[#e5133a] px-4 py-2 text-sm font-bold text-white">
              Open on YouTube ↗
            </a>
          </div>
        ) : playing ? (
          <iframe
            ref={frame}
            src={youtubeEmbedUrl(video.youtubeId, { autoplay: true, origin })}
            title={`Live video, ${video.court}`}
            className="absolute inset-0 h-full w-full border-0"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button type="button" onClick={() => setPlaying(true)} className="group absolute inset-0 h-full w-full" aria-label={`Watch the live video of ${video.court}`} data-testid="live-video-play">
            <img src={youtubeThumbnailUrl(video.youtubeId)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" />
            <span className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
            <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-[#e5133a] px-2.5 py-1 text-[11px] font-black uppercase tracking-widest text-white">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> Live video · {video.court}
            </span>
            <span className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-2xl text-black shadow-lg transition group-hover:scale-105">
              ▶
            </span>
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>{delayNote(video)}</span>
        <a href={watch} target="_blank" rel="noreferrer" className="font-semibold text-accent" data-testid="open-on-youtube">
          Open on YouTube ↗
        </a>
      </div>
    </section>
  );
}
