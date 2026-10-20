import { notFoundJson, publicJson } from "@/lib/mobile/http";
import { publicEventInfoBySlug } from "@/lib/eventInfo/server";

/**
 * GET /api/mobile/v1/t/<slug>/info: the published event info of a public
 * tournament (its event group's), as src/lib/eventInfo/public.ts projects it:
 * named fields only, cleaned on the way out. Shared by every phone; the CDN
 * keeps a minute. Unpublished or not public → 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const info = await publicEventInfoBySlug(slug);
  return info ? publicJson(info, 60, 600) : notFoundJson("No event info");
}
