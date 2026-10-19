/**
 * Branding on every file a user downloads or prints (owner's decision, 20 Oct 2026):
 * the court QR sheet, the team coach cards, the line-up sheet, the tournament workbook,
 * the share images. One look everywhere:
 *   - Move Score's lockup and Move Beyond's logo on a navy band (Move Score's own navy);
 *   - the event's name, logo and colours, and the organisation's logo and colours when set;
 *   - the footer line "Move Score by Move Beyond · tour.mbeg.org";
 *   - on printed cards, the event's sponsors, small, at the bottom.
 *
 * Pure (no Node, browser or Next.js APIs): `resolveEventBrand` turns the rows into what
 * every surface draws. The server side (rows, image bytes) is brand/server.ts; Excel is
 * brand/excel.ts; print pages use components/brand/PrintBrand.tsx.
 */
import { SITE_HOST } from "../site";
import { isHex, isSafeImageUrl, resolveSponsors } from "../sponsors";
import type { BrandingConfig } from "../types";
import { MOVE_BEYOND_SLUG } from "../orgs/roles";

export const BRAND = {
  product: "Move Score",
  maker: "Move Beyond",
  host: SITE_HOST,
  /** The line at the foot of every printed or exported file. */
  footer: `Move Score by Move Beyond · ${SITE_HOST}`,
  /** Move Score's navy (the lockup's own background). */
  navy: "#01041A",
  ball: "#FCFC00",
  stage: "#1E6BFF",
  ink: "#0B0E1F",
  muted: "#5A6178",
  /** Public paths (public/): the lockup sits on navy; Move Beyond's logo in white for the band, black for paper. */
  lockup: "/email/move-score-lockup@2x.png",
  lockupAspect: 960 / 183,
  icon: "/email/move-score-icon-192.png",
  moveBeyondWhite: "/brand/move-beyond-logo-white.png",
  moveBeyondBlack: "/brand/move-beyond-logo-black.png",
  moveBeyondAspect: 528 / 224,
} as const;

export interface BrandLogo {
  url: string;
  name: string;
}

export interface EventBrand {
  /** "Junior Team Finals · Cairo 2026" (the event group) or the tournament's own name. */
  eventName: string;
  /** The tournament's own name when it differs from eventName ("Davis Cup Juniors"). */
  subtitle: string | null;
  /** The event's logo (branding → event logo, else the app skin's logo). */
  eventLogo: BrandLogo | null;
  /** The organisation's logo (its profile, else the tournament's client logo), unless it is Move Beyond itself. */
  orgLogo: BrandLogo | null;
  orgName: string | null;
  /** `#rrggbb`: the event's colour (organisation → app skin → Move Score blue), and a second one. */
  primary: string;
  accent: string;
  /** The event's sponsors (main first), at most eight, for the foot of printed cards. */
  sponsors: BrandLogo[];
}

export interface BrandRows {
  tournament: { name: string; branding_config?: BrandingConfig | null; app_skin?: { seedA?: string | null; seedB?: string | null; logoUrl?: string | null } | null };
  group?: { name: string } | null;
  org?: { name: string; slug?: string | null; logo_url?: string | null; colors?: unknown } | null;
}

function hexOr(...xs: unknown[]): string | null {
  for (const x of xs) if (isHex(x)) return x.toLowerCase();
  return null;
}

/** What every branded surface draws for one event. */
export function resolveEventBrand(rows: BrandRows): EventBrand {
  const t = rows.tournament;
  const b = t.branding_config ?? {};
  const skin = t.app_skin ?? {};
  const org = rows.org ?? null;
  const colors = (org?.colors && typeof org.colors === "object" ? org.colors : {}) as Record<string, unknown>;
  const eventName = (rows.group?.name ?? t.name).trim() || t.name;
  // Move Beyond's own events: its logo is already on the band.
  const isMoveBeyond = org?.slug === MOVE_BEYOND_SLUG;
  const eventLogoUrl = [b.eventLogoUrl, skin.logoUrl].find(isSafeImageUrl) ?? null;
  const orgLogoUrl = isMoveBeyond ? null : ([org?.logo_url, b.clientLogoUrl].find(isSafeImageUrl) ?? null);
  const sp = resolveSponsors(b);
  const sponsors = [...(sp.main ? [{ url: sp.main.logoUrl, name: sp.main.name }] : []), ...sp.footer.map((s) => ({ url: s.logoUrl, name: s.name ?? "" }))].slice(0, 8);
  const primary = hexOr(skin.seedA, colors.primary) ?? BRAND.stage.toLowerCase();
  const accent = hexOr(skin.seedB, colors.accent) ?? BRAND.ball.toLowerCase();
  return {
    eventName,
    subtitle: rows.group && rows.group.name.trim() !== t.name.trim() ? t.name : null,
    eventLogo: eventLogoUrl && eventLogoUrl !== orgLogoUrl ? { url: eventLogoUrl, name: eventName } : null,
    orgLogo: orgLogoUrl ? { url: orgLogoUrl, name: org?.name ?? "" } : null,
    orgName: org?.name ?? null,
    primary,
    accent,
    sponsors,
  };
}

/** The default look (no event): Move Score's own. */
export function plainBrand(eventName: string): EventBrand {
  return { eventName, subtitle: null, eventLogo: null, orgLogo: null, orgName: null, primary: BRAND.stage.toLowerCase(), accent: BRAND.ball.toLowerCase(), sponsors: [] };
}

/** "#1e6bff" → "FF1E6BFF" (ExcelJS ARGB). */
export function argb(hex: string): string {
  return `FF${(isHex(hex) ? hex.slice(1) : BRAND.navy.slice(1)).toUpperCase()}`;
}

/** Black or white text on a background colour (WCAG relative luminance). */
export function textOn(hex: string): "#ffffff" | "#0b0e1f" {
  const h = isHex(hex) ? hex.slice(1) : "000000";
  const lin = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return L > 0.4 ? "#0b0e1f" : "#ffffff";
}

/** A file name part from an event name: "Junior Team Finals · Cairo 2026" → "junior-team-finals-cairo-2026". */
export function fileSlug(s: string, max = 50): string {
  return s.normalize("NFKD").replace(/[^\w\s-]/g, " ").trim().toLowerCase().replace(/[\s_-]+/g, "-").replace(/^-|-$/g, "").slice(0, max) || "move-score";
}
