import { getOrgProfile } from "@/lib/mobile/orgs";
import { notFoundJson, publicJson } from "@/lib/mobile/http";

/** An organisation's public page: profile, branding, tournaments. Public fields only (src/lib/mobile/orgs.ts). */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const profile = await getOrgProfile(slug);
  if (!profile) return notFoundJson("Organisation not found");
  return publicJson(profile, 30, 300);
}
