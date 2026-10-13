import { NextResponse } from "next/server";
import { joinLeague } from "@/lib/leagues/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import type { MJoinResult } from "@/lib/mobile/contract";

/**
 * POST { code?, divisionId? } → MJoinResult. A signed-in account joins (or asks
 * to join) a league as its linked player profile. 409 { code: "link_profile" }
 * when the account has no player profile yet. Invite-code guesses are
 * rate-limited per account; the code is never logged.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in to join a league.", code: "sign_in" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const body = (await readJson<Record<string, unknown>>(request)) ?? {};
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "code" && k !== "divisionId")) return privateJson({ error: "Send code and divisionId only." }, 400);
  if (body.code !== undefined && body.code !== null && (typeof body.code !== "string" || body.code.length > 40)) return privateJson({ error: "That invite code doesn't look right." }, 400);
  if (body.divisionId !== undefined && body.divisionId !== null && typeof body.divisionId !== "string") return privateJson({ error: "Pick a division." }, 400);
  const r = await joinLeague({ slug, userId: owner.id, code: body.code ?? undefined, divisionId: body.divisionId ?? undefined });
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  const out: MJoinResult = { outcome: r.outcome, status: r.status, payAtVenue: r.payAtVenue, message: r.message };
  return privateJson(out);
}
