/**
 * Sponsors: who glows, who loops, and how bright either may be.
 *
 * Pure and framework-free. Every page reads sponsors through `resolveSponsors`,
 * so the legacy `sponsorLogoUrls` list and the newer named `sponsors` list are
 * one thing everywhere, and the main sponsor never also appears in the footer.
 */
import type { BrandingConfig, DisplayMode, MainSponsor, SponsorEntry, SponsorIntensity } from "./types";

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

/** Only absolute https URLs (or our own storage over http in development) are rendered. */
export function isSafeImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1000) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

function cleanAspect(aspect: unknown): number | undefined {
  return typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0.05 && aspect < 40 ? aspect : undefined;
}

export interface ResolvedSponsors {
  main: MainSponsor | null;
  footer: SponsorEntry[];
}

/** How the looping band draws its logos. Both surfaces read the same two answers. */
export interface SponsorStyle {
  /** A white panel behind each logo. */
  chips: boolean;
  /** One identical box for every logo, rather than one equal area each. */
  uniform: boolean;
}

/**
 * The band's two display choices.
 *
 * Defaults are what every tournament had before they existed: chips on, because
 * a dark wall swallows a dark logo; areas rather than boxes, because equal
 * heights make a wide wordmark shout over a square crest.
 */
export function sponsorStyle(branding: BrandingConfig | null | undefined): SponsorStyle {
  return {
    chips: branding?.sponsorChips !== false,
    uniform: branding?.sponsorUniformSize === true,
  };
}

export function resolveSponsors(branding: BrandingConfig | null | undefined): ResolvedSponsors {
  const b = branding ?? {};
  const m = b.mainSponsor;
  const main: MainSponsor | null =
    m && isSafeImageUrl(m.logoUrl)
      ? {
          name: (m.name ?? "").trim(),
          logoUrl: m.logoUrl,
          accentHex: isHex(m.accentHex) ? m.accentHex : "#00aeef",
          intensity: m.intensity === "subtle" || m.intensity === "vivid" ? m.intensity : "standard",
          showOnDashboard: m.showOnDashboard !== false,
          aspect: cleanAspect(m.aspect),
        }
      : null;

  // The named list wins once it exists — even empty, which means "cleared" —
  // so a tournament that has been edited under the new form is never mixed
  // with the legacy URLs it replaced.
  const source: SponsorEntry[] = Array.isArray(b.sponsors)
    ? b.sponsors
    : (b.sponsorLogoUrls ?? []).map((logoUrl) => ({ name: "", logoUrl }));

  const seen = new Set<string>(main ? [main.logoUrl] : []);
  const footer: SponsorEntry[] = [];
  for (const s of source) {
    if (!s || !isSafeImageUrl(s.logoUrl) || seen.has(s.logoUrl)) continue;
    seen.add(s.logoUrl);
    footer.push({
      name: (s.name ?? "").trim(),
      logoUrl: s.logoUrl,
      ...(s.tier ? { tier: s.tier } : {}),
      ...(cleanAspect(s.aspect) ? { aspect: cleanAspect(s.aspect) } : {}),
    });
  }
  return { main, footer };
}

/* ------------------------------------------------------------------ */
/* How bright the glow may be                                          */
/* ------------------------------------------------------------------ */

export type WatermarkSurface = "live_dense" | "live_sparse" | "board" | "slate" | "dashboard";

/** Base opacity of the mark per surface, before the sponsor's intensity. */
export const WATERMARK_BASE: Record<WatermarkSurface, number> = {
  // Behind three or four live cards the score is the job; the glow is a hint.
  live_dense: 0.06,
  live_sparse: 0.09,
  board: 0.11,
  // Holding, ceremony, winner: nothing competes, so the sponsor may carry the frame.
  slate: 0.2,
  dashboard: 0.08,
};

export const INTENSITY_SCALE: Record<SponsorIntensity, number> = { subtle: 0.55, standard: 1, vivid: 1.5 };

/** The ceiling on how far the glow may move the page background's luminance. */
export const MAX_LUMINANCE_SHIFT = 0.06;

export function surfaceForMode(mode: DisplayMode, courtCount: number): WatermarkSurface {
  switch (mode) {
    case "live":
    case "live_court":
    case "all_live":
      return courtCount >= 3 ? "live_dense" : "live_sparse";
    case "leaderboard":
    case "bracket":
    case "sponsors":
      return "board";
    case "holding":
    case "ceremony":
    case "winner":
      return "slate";
  }
}

export function markOpacity(surface: WatermarkSurface, intensity: SponsorIntensity = "standard"): number {
  return Math.min(0.3, WATERMARK_BASE[surface] * INTENSITY_SCALE[intensity]);
}

/* ------------------------------------------------------------------ */
/* Colour maths, for the gates                                         */
/* ------------------------------------------------------------------ */

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = isHex(hex) ? hex.slice(1) : "000000";
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Source-over compositing of `top` at `alpha` onto an opaque `bottom`, in sRGB. */
export function composite(bottom: Rgb, top: Rgb, alpha: number): Rgb {
  const a = Math.max(0, Math.min(1, alpha));
  return [0, 1, 2].map((i) => bottom[i] * (1 - a) + top[i] * a) as Rgb;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The strongest alpha, up to `wanted`, at which `accent` laid over `background`
 * moves its luminance by no more than the ceiling. A pale yellow on white or a
 * bright green on black would otherwise wash the whole wall; this makes the gate
 * hold by construction rather than by a check that someone forgets to run.
 */
export function bloomAlpha(backgroundHex: string, accentHex: string, wanted: number, ceiling = MAX_LUMINANCE_SHIFT): number {
  const bg = hexToRgb(backgroundHex);
  const accent = hexToRgb(accentHex);
  const base = relativeLuminance(bg);
  const shift = (a: number) => Math.abs(relativeLuminance(composite(bg, accent, a)) - base);
  if (shift(wanted) <= ceiling) return wanted;
  // Luminance is monotonic in alpha along a straight blend, so bisect.
  let lo = 0;
  let hi = wanted;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (shift(mid) <= ceiling) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/* ------------------------------------------------------------------ */
/* The footer loop                                                     */
/* ------------------------------------------------------------------ */

export interface LogoBox {
  width: number;
  height: number;
}

/**
 * A logo's box in the band, known before the image loads.
 *
 * Sized by area rather than height, so a wide wordmark and a square crest read
 * as the same weight: equal heights make wordmarks shout. A logo whose shape is
 * unknown gets a 2:1 box and is contained inside it.
 *
 * `uniform` overrides all of that with one 2:1 box for everybody — every panel
 * the same size down the band, each logo as large as it can be inside its own.
 * Nothing is ever distorted to fill a box: a stretched logo is a sponsor's
 * trademark drawn wrongly, and that is not ours to do.
 */
export function logoBox(aspect: number | undefined, maxHeight: number, uniform = false): LogoBox {
  if (uniform) return { width: Math.round(maxHeight * 2), height: Math.round(maxHeight) };
  const a = aspect ?? 2;
  const area = maxHeight * maxHeight * 2.2;
  const height = Math.max(maxHeight * 0.5, Math.min(maxHeight, Math.sqrt(area / a)));
  return { width: Math.round(height * a), height: Math.round(height) };
}

export interface TickerPlan {
  /** Width of one pass through every logo, gaps included. */
  groupWidth: number;
  /** How many copies of the group the track holds so it never runs dry. */
  copies: number;
  /** Seconds for one group to scroll past. */
  durationS: number;
}

export const TICKER_PX_PER_SECOND = 32;

export function tickerPlan(
  logos: { aspect?: number }[],
  viewportWidth: number,
  maxHeight: number,
  gap: number,
  uniform = false,
): TickerPlan {
  const groupWidth = logos.reduce((sum, l) => sum + logoBox(l.aspect, maxHeight, uniform).width + gap, 0);
  if (groupWidth <= 0) return { groupWidth: 0, copies: 0, durationS: 0 };
  return {
    groupWidth,
    // One extra copy past the viewport, so the seam is always off-screen.
    copies: Math.max(2, Math.ceil(viewportWidth / groupWidth) + 1),
    durationS: Math.max(8, groupWidth / TICKER_PX_PER_SECOND),
  };
}
