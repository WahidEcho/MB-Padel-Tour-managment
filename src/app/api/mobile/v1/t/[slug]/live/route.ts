import { getLive } from "@/lib/mobile/server";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/**
 * Every tie and match with its score. Polled every few seconds; the CDN shares one copy. A stale
 * copy is served for at most 2 s while it refreshes (was 10 s: on a quiet event every phone saw
 * the old copy, 5-10 s behind; owner, 2 Nov 2026).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const live = await getLive(slug);
  return live ? publicJson(live, 1, 2) : notFoundJson("Tournament not found");
}
