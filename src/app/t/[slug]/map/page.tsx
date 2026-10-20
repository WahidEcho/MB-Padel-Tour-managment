import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import VenueMap from "@/components/venue/VenueMap";
import { publicVenueBySlug } from "@/lib/venue/server";

/**
 * /t/<slug>/map: the venue in 3D with directions. The Move Score app shows this
 * page in a WebView (?embed=app&theme=dark|light) and feeds it the phone's
 * location; "Show on map" links add ?court=<courts.id>.
 */
export const dynamic = "force-dynamic";

export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: "cover" };

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const venue = await publicVenueBySlug(slug);
  return { title: venue ? `${venue.doc.name} · map` : "Venue map", robots: { index: false } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function VenueMapPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ embed?: string; theme?: string; focus?: string; court?: string }>;
}) {
  const { slug } = await params;
  const q = await searchParams;
  const venue = await publicVenueBySlug(slug);
  if (!venue) notFound();
  const embed = q.embed === "app";
  const theme = q.theme === "dark" || q.theme === "light" ? q.theme : null;
  const focus = q.court && UUID.test(q.court) ? `courtrow:${q.court}` : q.focus && /^(court|poi|courtrow):[A-Za-z0-9_-]{1,40}$/.test(q.focus) ? q.focus : null;
  return (
    <div className="flex flex-col" style={{ height: "100dvh" }}>
      {!embed && (
        <header className="flex items-center gap-3 border-b border-border px-4 py-2 text-sm">
          <Link href={`/t/${slug}`} className="font-semibold text-muted hover:text-foreground">
            ← Back
          </Link>
          <span className="truncate font-bold">{venue.doc.name}</span>
        </header>
      )}
      <div className="relative min-h-0 flex-1">
        <VenueMap doc={venue.doc} version={venue.version} slug={slug} liveUrl={`/api/mobile/v1/t/${slug}/venue/live`} theme={theme} embed={embed} focus={focus} />
      </div>
    </div>
  );
}
