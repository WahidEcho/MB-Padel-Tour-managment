/**
 * Player portraits: which file to show, how to frame it, and what size to ask
 * the CDN for.
 *
 * Framework-free and pure, so both server components and the venue screen use
 * the same rules.
 */

/** The four photo fields, wherever they came from. */
export interface Portrait {
  /** The original photo. */
  photoUrl: string | null;
  /** A transparent cut-out, preferred on the big cards when one exists. */
  portraitUrl: string | null;
  focalX: number;
  focalY: number;
}

interface PhotoFields {
  photo_url?: string | null;
  portrait_url?: string | null;
  focal_x?: number | null;
  focal_y?: number | null;
}

/** Horizontally centred, above the middle: faces sit in the upper third. */
export const DEFAULT_FOCAL: [number, number] = [0.5, 0.35];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * Resolves one person's portrait.
 *
 * A tournament `players` row may be linked to a persistent profile. The profile
 * wins **field by field, and only when its field is set**, so a tournament
 * player with their own photo keeps it even when linked to a profile that has
 * none. Nothing is ever copied onto the players row: the name path already
 * drifts that way (a pair's `full_name` is copied at pairing time and never
 * re-synced), and photos would drift the same way on every profile edit.
 */
export function resolvePortrait(row: PhotoFields | null | undefined, profile?: PhotoFields | null): Portrait {
  const pick = <K extends keyof PhotoFields>(key: K) => profile?.[key] ?? row?.[key] ?? null;
  return {
    photoUrl: (pick("photo_url") as string | null) || null,
    portraitUrl: (pick("portrait_url") as string | null) || null,
    focalX: clamp01(Number(pick("focal_x") ?? DEFAULT_FOCAL[0])),
    focalY: clamp01(Number(pick("focal_y") ?? DEFAULT_FOCAL[1])),
  };
}

/** The file to paint: the cut-out when there is one, else the original. */
export function portraitSrc(p: Portrait): string | null {
  return p.portraitUrl || p.photoUrl || null;
}

/** A CSS `object-position` that keeps the face in frame at any aspect ratio. */
export function focalPosition(p: Pick<Portrait, "focalX" | "focalY">): string {
  return `${(clamp01(p.focalX) * 100).toFixed(1)}% ${(clamp01(p.focalY) * 100).toFixed(1)}%`;
}

const PUBLIC_OBJECT = "/storage/v1/object/public/";
const RENDER_IMAGE = "/storage/v1/render/image/public/";

/**
 * Asks Supabase's image CDN for a right-sized copy.
 *
 * Originals are served `cache-control: no-cache`, so every poll on a TV
 * re-validates every photo and logo; the render endpoint answers
 * `max-age=3600` and negotiates WebP from the browser's Accept header — a
 * 958 KB PNG comes back as roughly 5 KB.
 *
 * `resize=contain` is load-bearing: the endpoint defaults to `cover`, and cover
 * with a width and no height keeps the *original* height, which squashes every
 * face. Cropping to a square is CSS's job (`object-fit` plus the focal point),
 * never the CDN's.
 *
 * Anything that is not one of our own public storage objects — an external
 * host, a `data:` URI, a relative path, or a URL that already carries a query
 * string — is returned untouched.
 */
export function sizedImageSrc(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  if (url.includes("?")) return url;
  const at = url.indexOf(PUBLIC_OBJECT);
  if (at === -1) return url;
  const rendered = url.slice(0, at) + RENDER_IMAGE + url.slice(at + PUBLIC_OBJECT.length);
  return `${rendered}?width=${Math.round(width)}&resize=contain&quality=80`;
}

/**
 * Delivery widths. A card asks for the next size up from its own box, so one
 * stored original serves an avatar and a 65-inch wall without either being
 * oversized.
 */
export const PORTRAIT_WIDTHS = {
  /** Admin lists and the score sheet. */
  avatar: 160,
  /** Court cards on the venue screen. */
  card: 320,
  /** Entrance cards and the podium. */
  hero: 800,
} as const;

/** The width to request for a box rendered this many CSS pixels wide. */
export function deliveryWidth(boxPx: number): number {
  if (boxPx <= 80) return PORTRAIT_WIDTHS.avatar;
  if (boxPx <= 200) return PORTRAIT_WIDTHS.card;
  return PORTRAIT_WIDTHS.hero;
}
