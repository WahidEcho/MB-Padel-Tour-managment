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
import { defaultScreenSettings } from "@/lib/data";
import { publicScreenSettings } from "@/lib/publicData";
import { memo } from "@/lib/mobile/http";
import { buildLiveFeed } from "@/lib/tv/liveFeedServer";

/**
 * Every TV and overlay on one screen asks for the same feed every couple of seconds.
 * One build per second is shared by all of them: in this server instance (memo) and
 * at the CDN (s-maxage=1). A second old is still live for a court TV, whose clocks
 * run from the feed's own fetchedAt; on match day (2 Nov 2026) the unshared feed
 * was part of the load that filled the database's connection pool.
 */
const FEED_MS = 1_000;

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const screenKey = new URL(req.url).searchParams.get("screen") || MAIN_SCREEN;
  if (!isValidScreenKey(screenKey)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const feed = await memo(`tvfeed:${slug}:${screenKey}`, FEED_MS, async () => {
    const { data: tournament } = await db()
      .from("tournaments")
      .select("id, public_access_enabled, updated_at")
      .eq("slug", slug)
      .maybeSingle();
    const t = tournament as { id: string; public_access_enabled: boolean; updated_at: string | null } | null;
    if (!t || !t.public_access_enabled) return null;
    const screen = await publicScreenSettings(t.id, screenKey);
    if (!screen && screenKey !== MAIN_SCREEN) return null;
    return buildLiveFeed(t.id, screen ?? defaultScreenSettings(t.id, screenKey), t.updated_at ?? null);
  });
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(feed, {
    // Shared for one second (see FEED_MS) and never served stale: a TV is at most about a second behind.
    headers: { "Cache-Control": "public, max-age=0, s-maxage=1" },
  });
}
