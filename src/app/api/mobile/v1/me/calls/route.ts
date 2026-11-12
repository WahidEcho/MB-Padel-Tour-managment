import { NextResponse } from "next/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { takeRateLimit } from "@/lib/ratelimit";
import { myOpenCalls } from "@/lib/matchday/server";

/**
 * The calls ringing on a player's phone (owner, 12 Nov 2026): the open calls to court of the
 * account's own matches (claimed player codes).
 *
 *   GET → { calls: [{ matchId, tournamentName, court, label, calledAt, deadlineAt, mySide, aName, bName, myAnswer, present }] }
 *         | 401 signed out. Private, never cached.
 */
export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const rl = await takeRateLimit({ key: `my-calls:${owner.id}`, limit: 600, windowSeconds: 600 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds), "Cache-Control": "no-store" } });
  }
  return privateJson({ calls: await myOpenCalls(owner.id) });
}
