import { getBundle } from "@/lib/mobile/server";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/** Everything about a tournament that changes rarely: teams, players, courts, groups, sponsors, skin. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const bundle = await getBundle(slug);
  return bundle ? publicJson(bundle, 60, 600) : notFoundJson("Tournament not found");
}
