import { getPublicLeague } from "@/lib/leagues/server";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/**
 * A league's public page: how to join, the points rules, boards for a period
 * (?period=1|3|6|9|12&month=YYYY-MM), nights and fixtures. Names and numbers only
 * (src/lib/leagues/server.ts): never a profile id, a phone, an email or a photo.
 * Public and shared by every phone, so nothing here reads who is asking: the
 * account's own place is GET /me/leagues. Only a league anyone may see
 * ('everyone'); a 'Members only' or 'Invite only' league is the same 404 as a
 * missing one here, for everyone (so the CDN can keep that answer too), and is
 * served to the accounts that may see it on GET /me/leagues/<slug> (never cached).
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const url = new URL(request.url);
  const league = await getPublicLeague(slug, url.searchParams.get("period") ?? undefined, url.searchParams.get("month") ?? undefined);
  if (!league) return notFoundJson("League not found");
  return publicJson(league, 15, 120);
}
