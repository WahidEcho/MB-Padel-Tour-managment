import { sizedImageSrc } from "@/lib/portrait";
import { bloomAlpha, markOpacity, rgba, type WatermarkSurface } from "@/lib/sponsors";
import type { MainSponsor } from "@/lib/types";

/**
 * The main sponsor, glowing behind everything.
 *
 * Four stacked layers with no hooks, so it renders on the server: a static wash,
 * a bloom in the sponsor's colour that breathes slowly, a soft ring that turns
 * once every ninety seconds, and the mark itself breathing in scale. The mark
 * never rotates — a turning wordmark reads as a glitch, a turning halo reads as
 * intentional — and its glow is a static drop-shadow, because an animated filter
 * re-rasterises the logo on every frame.
 *
 * Opacity is capped per surface and the bloom is clamped so it cannot move the
 * background's luminance by more than 6%, whatever colour the sponsor brings.
 */
export default function SponsorWatermark({
  sponsor,
  surface,
  backgroundHex,
  variant = "stage",
}: {
  sponsor: MainSponsor | null;
  surface: WatermarkSurface;
  /** The ground the glow sits on, for the luminance clamp. */
  backgroundHex: string;
  /** A 1920x1080 venue stage, or a scrolling page where the glow is fixed to the viewport. */
  variant?: "stage" | "page";
}) {
  if (!sponsor) return null;
  const opacity = markOpacity(surface, sponsor.intensity);
  const accent = sponsor.accentHex;
  const bloom = bloomAlpha(backgroundHex, accent, opacity * 1.2);
  const wash = bloomAlpha(backgroundHex, accent, opacity * 0.5);
  const stage = variant === "stage";
  // Stage pixels on the wall; viewport units on a page, so a phone gets the same composition.
  const markWidth = stage ? "1190px" : "62vw";
  const ring = stage ? "1300px" : "70vmax";
  const bloomSize = stage ? "1500px" : "90vmax";
  const src = sizedImageSrc(sponsor.logoUrl, stage ? 1280 : 1024) ?? sponsor.logoUrl;

  return (
    <div
      aria-hidden
      data-testid="sponsor-watermark"
      data-surface={surface}
      data-opacity={opacity.toFixed(3)}
      className={`bc-watermark pointer-events-none overflow-hidden ${stage ? "absolute inset-0" : "bc-watermark-page fixed inset-0"}`}
      // On a page the glow sits at -1 inside an isolated parent: above the page's
      // own ground, below its in-flow content, with no z-index needed on siblings.
      style={{ zIndex: stage ? 0 : -1 }}
    >
      {/* 1. Static wash, so the colour is present even between breaths. */}
      <div
        className="absolute inset-0"
        style={{ background: `radial-gradient(120% 90% at 50% 42%, ${rgba(accent, wash)} 0%, transparent 70%)` }}
      />
      {/* 2. Bloom, breathing over 26s. */}
      <div
        data-ambient
        className="absolute left-1/2 top-[42%]"
        style={{
          width: bloomSize,
          height: bloomSize,
          marginLeft: `calc(${bloomSize} / -2)`,
          marginTop: `calc(${bloomSize} / -2)`,
          background: `radial-gradient(circle, ${rgba(accent, bloom)} 0%, ${rgba(accent, bloom * 0.35)} 35%, transparent 62%)`,
          animation: "bc-bloom 26s ease-in-out infinite",
        }}
      />
      {/* 3. Ring behind the mark, one turn every 90s. */}
      <div
        data-ambient
        className="absolute left-1/2 top-[42%]"
        style={{
          width: ring,
          height: ring,
          marginLeft: `calc(${ring} / -2)`,
          marginTop: `calc(${ring} / -2)`,
          borderRadius: "9999px",
          background: `conic-gradient(from 0deg, transparent 0deg, ${rgba(accent, opacity * 1.6)} 60deg, transparent 150deg, ${rgba(accent, opacity)} 230deg, transparent 320deg)`,
          WebkitMaskImage: "radial-gradient(circle, transparent 56%, #000 61%, #000 66%, transparent 71%)",
          maskImage: "radial-gradient(circle, transparent 56%, #000 61%, #000 66%, transparent 71%)",
          filter: "blur(14px)",
          animation: "bc-ring 90s linear infinite",
        }}
      />
      {/* 4. The mark. */}
      <div
        data-ambient
        className="absolute left-1/2 top-[42%] flex items-center justify-center"
        style={{
          width: markWidth,
          height: stage ? "560px" : "40vh",
          marginLeft: `calc(${markWidth} / -2)`,
          marginTop: stage ? "-280px" : "-20vh",
          animation: "bc-mark-breathe 13s ease-in-out infinite",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          loading="eager"
          decoding="async"
          className="h-full w-full object-contain"
          style={{ opacity, filter: `drop-shadow(0 0 48px ${rgba(accent, 0.9)})` }}
        />
      </div>
    </div>
  );
}
