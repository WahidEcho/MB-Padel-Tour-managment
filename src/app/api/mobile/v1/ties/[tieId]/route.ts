import { db } from "@/lib/supabase";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/** Which tournament a tie belongs to, so an alert's link can open it. */
export async function GET(_request: Request, { params }: { params: Promise<{ tieId: string }> }) {
  const { tieId } = await params;
  const { data } = await db().from("ties").select("id, tournament_id, tournaments(slug, kind, public_access_enabled)").eq("id", tieId).maybeSingle();
  const row = data as unknown as { id: string; tournaments: { slug: string; kind: string; public_access_enabled: boolean } | null } | null;
  if (!row?.tournaments || !row.tournaments.public_access_enabled || row.tournaments.kind !== "tournament") return notFoundJson("Tie not found");
  return publicJson({ tieId: row.id, tournamentSlug: row.tournaments.slug }, 300, 3600);
}
