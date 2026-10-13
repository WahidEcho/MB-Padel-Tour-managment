import { getOrgProfile } from "@/lib/mobile/orgs";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/** An organisation's public page: profile, branding, tournaments, leagues and its top board. Public fields only (src/lib/mobile/orgs.ts). */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  // ?month=YYYY-MM picks the month of its top board (default: this month).
  const profile = await getOrgProfile(slug, new URL(request.url).searchParams.get("month") ?? undefined);
  if (!profile) return notFoundJson("Organisation not found");
  return publicJson(profile, 30, 300);
}
