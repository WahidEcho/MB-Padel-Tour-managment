import { notFoundJson, publicJson } from "@/lib/mobile/http";
import { publicFeed, publicTournamentId } from "@/lib/stories/server";

/** One public event's live stories (the event hub's row), shared at the CDN like GET /stories. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const id = await publicTournamentId(slug);
  if (!id) return notFoundJson("Tournament not found");
  return publicJson(await publicFeed(id), 10, 30);
}
