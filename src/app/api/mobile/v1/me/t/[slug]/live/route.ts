import { NextResponse } from "next/server";
import { getLive } from "@/lib/mobile/server";
import { tournamentVisibleTo } from "@/lib/leagues/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";

/**
 * Every tie and match with its score, for the signed-in account (the same shape as GET /t/<slug>/live):
 * also the nights and season of a league it may see that is not public
 * (src/lib/leagues/visibility.ts), and a night it plays in itself. Never cached
 * anywhere; anything it may not read is the same 404 as a missing tournament.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  if (!(await tournamentVisibleTo(slug, owner.id))) return privateJson({ error: "Tournament not found" }, 404);
  const out = await getLive(slug, { restricted: true });
  return out ? privateJson(out) : privateJson({ error: "Tournament not found" }, 404);
}
