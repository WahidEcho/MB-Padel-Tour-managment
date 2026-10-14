import { NextResponse } from "next/server";
import { getLeagueForUser } from "@/lib/leagues/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";

/**
 * A league's page for the signed-in account (the same MLeague as GET
 * /leagues/<slug>, same ?period= and ?month=): any league it may see, including
 * a 'Members only' or 'Invite only' one (src/lib/leagues/visibility.ts). Never
 * cached anywhere: the answer depends on who asks. A league it may not see is the
 * same 404 as a league that does not exist.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const url = new URL(request.url);
  const league = await getLeagueForUser(slug, owner.id, url.searchParams.get("period") ?? undefined, url.searchParams.get("month") ?? undefined);
  if (!league) return privateJson({ error: "League not found" }, 404);
  return privateJson(league);
}
