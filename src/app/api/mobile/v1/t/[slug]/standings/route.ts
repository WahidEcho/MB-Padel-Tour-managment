import { getStandings } from "@/lib/mobile/server";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await getStandings(slug);
  return s ? publicJson(s, 15, 120) : notFoundJson("Tournament not found");
}
