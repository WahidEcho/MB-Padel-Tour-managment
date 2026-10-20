import { notFoundJson, publicJson } from "@/lib/mobile/http";
import { publicVenueBySlug } from "@/lib/venue/server";

/**
 * GET /api/mobile/v1/t/<slug>/venue: the published venue map of a public
 * tournament (its event group's), as src/lib/venue/public.ts projects it: no
 * underlay, no survey fixes. Shared by every phone; the CDN keeps a minute.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const venue = await publicVenueBySlug(slug);
  return venue ? publicJson(venue, 60, 600) : notFoundJson("No venue map");
}
