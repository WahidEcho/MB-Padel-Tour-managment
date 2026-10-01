import { getLive } from "@/lib/mobile/server";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/** Every tie and match with its score. Polled every few seconds; the CDN shares one copy. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const live = await getLive(slug);
  return live ? publicJson(live, 2, 10) : notFoundJson("Tournament not found");
}
