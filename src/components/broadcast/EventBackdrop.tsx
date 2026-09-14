"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { dimPercent } from "@/lib/background";
import { ROWS } from "@/lib/tv/layout";
import type { EventBackground } from "@/lib/types";
import { useLive } from "./LiveFeedProvider";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Draws the image's current frame onto the canvas at the screen's pixel density, cropped like object-fit: cover. */
function drawCover(img: HTMLImageElement, canvas: HTMLCanvasElement) {
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (!cssWidth || !cssHeight || !img.complete || img.naturalWidth === 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const scale = Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  try {
    ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  } catch {
    // An image that cannot be drawn leaves the plain ground showing.
  }
}

/** How long a failed video waits before it is loaded again. */
const RETRY_MS = [5_000, 15_000, 60_000];

/**
 * The event's own background — a GIF, an animated SVG or picture, or a muted video
 * loop — at the very back, under the sponsor glow and all content.
 *
 * It follows the wall's motion setting: when an operator mutes animations (or a
 * control-room thumbnail renders the wall), a video pauses on its frame and stops
 * buffering, and an animated image is replaced by a still of its frame, since a
 * GIF cannot be paused. On a public page it also respects the visitor's
 * reduced-motion preference.
 *
 * A layer of the page colour sits over it at the organiser's chosen strength. On
 * the wall that layer is always strong behind the header and the sponsor band,
 * whose text sits on no card, so they stay readable whatever the artwork is.
 */
export default function EventBackdrop({
  background,
  variant = "stage",
}: {
  background: EventBackground;
  /** A 1920x1080 venue stage, or a scrolling page where it is fixed to the viewport. */
  variant?: "stage" | "page";
}) {
  const live = useLive();
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  const motion = variant === "stage" ? live.motion : !reducedMotion;
  // A plain JPEG has no frames to stop, so it never needs the canvas still.
  const animatable = background.mime !== "image/jpeg";

  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The URL whose playback the browser refused (Low Power Mode, autoplay blocked).
  const [refusedUrl, setRefusedUrl] = useState<string | null>(null);
  const refused = refusedUrl === background.url;

  // Video: always muted (a wall never plays sound), playing or paused with motion.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    video.defaultMuted = true;
    if (!motion) {
      video.pause();
      return;
    }
    const url = background.url;
    let alive = true;
    // A first touch anywhere on a phone usually allows a refused video to play.
    const retry = () => {
      void video
        .play()
        .then(() => {
          if (alive) setRefusedUrl(null);
        })
        .catch(() => {});
    };
    video.play().catch(() => {
      if (!alive) return;
      setRefusedUrl(url);
      document.addEventListener("pointerdown", retry, { once: true });
    });
    return () => {
      alive = false;
      document.removeEventListener("pointerdown", retry);
    };
  }, [motion, background.url]);

  // A video that failed to load (the venue uplink dropped mid-download) tries again
  // after a while instead of staying blank for the rest of the day.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onError = () => {
      if (timer) return;
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        video.load();
        if (!video.paused || motion) void video.play().catch(() => {});
      }, wait);
    };
    const onPlaying = () => {
      attempt = 0;
    };
    video.addEventListener("error", onError);
    video.addEventListener("playing", onPlaying);
    return () => {
      video.removeEventListener("error", onError);
      video.removeEventListener("playing", onPlaying);
      if (timer) clearTimeout(timer);
    };
  }, [motion, background.url]);

  // Animated image: a still of its current frame while motion is off, redrawn when
  // the layer changes size (a phone rotating, a browser toolbar collapsing).
  useEffect(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (motion || !animatable || !img || !canvas) return;
    const draw = () => drawCover(img, canvas);
    draw();
    img.addEventListener("load", draw);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(draw);
    resize?.observe(canvas);
    return () => {
      img.removeEventListener("load", draw);
      resize?.disconnect();
    };
  }, [motion, animatable, background.url]);

  const stage = variant === "stage";
  const scrim = dimPercent(background.dim);
  const layer = (percent: number) => `color-mix(in oklab, var(--background) ${percent}%, transparent)`;
  // On the wall, the header and the sponsor band keep a strong ground at any setting.
  const band = Math.max(scrim, 82);
  const headerEnd = (ROWS.header / 1080) * 100;
  const tickerStart = 100 - (ROWS.ticker / 1080) * 100;
  const scrimStyle = stage
    ? `linear-gradient(to bottom, ${layer(band)} 0%, ${layer(band)} ${headerEnd}%, ${layer(scrim)} ${headerEnd + 4}%, ${layer(scrim)} ${tickerStart - 4}%, ${layer(band)} ${tickerStart}%, ${layer(band)} 100%)`
    : layer(scrim);
  const showStill = !motion && animatable;

  return (
    <div
      aria-hidden
      data-testid="event-backdrop"
      data-kind={background.kind}
      data-motion={motion ? "on" : "off"}
      className={`pointer-events-none overflow-hidden ${stage ? "absolute inset-0" : "fixed inset-0"}`}
      style={{ zIndex: stage ? 0 : -1 }}
    >
      {background.kind === "video" ? (
        <video
          ref={videoRef}
          key={background.url}
          src={background.url}
          className="bc-backdrop-video h-full w-full object-cover"
          style={{ visibility: refused ? "hidden" : "visible" }}
          autoPlay={motion}
          muted
          loop
          playsInline
          // Paused, it needs only its first frame, not the whole file buffered.
          preload={motion ? "auto" : "metadata"}
          disablePictureInPicture
        />
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            key={background.url}
            src={background.url}
            alt=""
            loading="eager"
            decoding="async"
            className="h-full w-full object-cover"
            style={{ visibility: showStill ? "hidden" : "visible" }}
          />
          {showStill && <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />}
        </>
      )}
      {(scrim > 0 || stage) && <div className="absolute inset-0" style={{ background: scrimStyle }} />}
    </div>
  );
}
