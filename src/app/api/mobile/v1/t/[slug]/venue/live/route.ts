import { notFoundJson, publicJson } from "@/lib/mobile/http";
import { venueLiveBySlug } from "@/lib/venue/server";

/** GET /api/mobile/v1/t/<slug>/venue/live: each court's live line ("EGY 1–0 USA · 6–4 3–2"). Polled; the CDN shares one copy. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const live = await venueLiveBySlug(slug);
  return live ? publicJson(live, 2, 10) : notFoundJson("No venue map");
}
