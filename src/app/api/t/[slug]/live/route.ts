/**
 * The venue screen's live feed.
 *
 * Polled every couple of seconds by the screen itself, in place of a timed
 * router.refresh(). The reason is failure behaviour rather than speed: in this
 * version of Next a server-render fetch that fails falls back to a full page
 * navigation, so on a venue uplink hiccup the wall would flash white and reload
 * mid-animation. A plain JSON poll that fails is simply ignored — the screen
 * keeps showing its last good frame.
 *
 * Small on purpose: statuses, court assignments and scores, never team rows. Team
 * names and photos come from the server render through the public projection, so
 * nothing here can carry a phone number or a note.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { MAIN_SCREEN, isValidScreenKey } from "@/lib/screens";
import { defaultScreenSettings, getScreenSettings } from "@/lib/data";
import { buildLiveFeed } from "@/lib/tv/liveFeedServer";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const screenKey = new URL(req.url).searchParams.get("screen") || MAIN_SCREEN;
  if (!isValidScreenKey(screenKey)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: tournament } = await db()
    .from("tournaments")
    .select("id, public_access_enabled, updated_at")
    .eq("slug", slug)
    .maybeSingle();
  const t = tournament as { id: string; public_access_enabled: boolean; updated_at: string | null } | null;
  if (!t || !t.public_access_enabled) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const screen = await getScreenSettings(t.id, screenKey);
  if (!screen && screenKey !== MAIN_SCREEN) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const feed = await buildLiveFeed(t.id, screen ?? defaultScreenSettings(t.id, screenKey), t.updated_at ?? null);

  return NextResponse.json(feed, {
    // Never cached: a stale feed is the one thing this endpoint must not serve.
    headers: { "Cache-Control": "no-store" },
  });
}
