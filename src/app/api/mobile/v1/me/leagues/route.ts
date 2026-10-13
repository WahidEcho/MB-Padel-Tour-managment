import { NextResponse } from "next/server";
import { myLeagues } from "@/lib/leagues/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";

/**
 * GET → MMyLeagues: the signed-in account's leagues, membership status and this
 * month's rank in each (?league=<slug> narrows to one). Also what a league widget
 * reads. Never cached.
 */
export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const slug = new URL(request.url).searchParams.get("league") ?? undefined;
  return privateJson(await myLeagues(owner.id, slug));
}
