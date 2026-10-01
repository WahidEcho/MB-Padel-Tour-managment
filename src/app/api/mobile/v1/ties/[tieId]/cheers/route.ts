import { db } from "@/lib/supabase";
import { publicJson } from "@/lib/mobile/http";

/** The crowd meter for one tie. */
export async function GET(_request: Request, { params }: { params: Promise<{ tieId: string }> }) {
  const { tieId } = await params;
  const { data } = await db().from("tie_cheers").select("nation_code, count").eq("tie_id", tieId);
  return publicJson({ tieId, cheers: ((data ?? []) as { nation_code: string; count: number }[]).map((c) => ({ nation: c.nation_code, count: Number(c.count) })) }, 3, 15);
}
