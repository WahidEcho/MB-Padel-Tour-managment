import { unstable_cache } from "next/cache";
import { db } from "@/lib/supabase";
import { resolveSponsors } from "@/lib/sponsors";
import type { BrandingConfig } from "@/lib/types";

/**
 * The Cairo edition of tour.mbeg.org/app (owner, 31 Oct 2026): while the Davis Cup and BJK Cup
 * Junior Finals are on, the page people reach from the venue QR codes says which events the app
 * is for, links both events' web live scoring and runs every partner's logo along the foot.
 * The Orbit design (Orbit.tsx) comes back by itself once both events are completed or archived;
 * APP_PAGE_EDITION=orbit brings it back sooner without a code change.
 */
export const CAIRO_EVENTS = [
  { slug: "davis-cup-junior-finals-2026", short: "Davis Cup", logo: "/sponsors/cairo-2026/white/davis-cup-event.png" },
  { slug: "bjk-cup-junior-finals-2026", short: "Billie Jean King Cup", logo: "/sponsors/cairo-2026/white/bjk-cup-event.png" },
] as const;

export type CairoEdition = {
  events: { slug: string; name: string; short: string; logo: string }[];
  /** Every partner of either event, the master sponsors first, each logo once. */
  partners: string[];
};

const load = unstable_cache(
  async (): Promise<CairoEdition | null> => {
    const { data } = await db()
      .from("tournaments")
      .select("slug, name, status, branding_config")
      .in("slug", CAIRO_EVENTS.map((e) => e.slug));
    const rows = (data ?? []) as { slug: string; name: string; status: string; branding_config: BrandingConfig | null }[];
    if (!rows.some((r) => r.status === "draft" || r.status === "active")) return null;
    const events = CAIRO_EVENTS.flatMap((e) => {
      const row = rows.find((r) => r.slug === e.slug);
      return row ? [{ slug: e.slug, name: row.name, short: e.short, logo: e.logo }] : [];
    });
    const sponsors = rows.map((r) => resolveSponsors(r.branding_config));
    const partners = [
      ...new Set([...sponsors.flatMap((s) => (s.main ? [s.main.logoUrl] : [])), ...sponsors.flatMap((s) => s.footer.map((f) => f.logoUrl))]),
    ];
    return { events, partners };
  },
  ["app-page-cairo-edition"],
  { revalidate: 300 },
);

export async function cairoEdition(): Promise<CairoEdition | null> {
  if (process.env.APP_PAGE_EDITION === "orbit") return null;
  try {
    return await load();
  } catch {
    return null;
  }
}
