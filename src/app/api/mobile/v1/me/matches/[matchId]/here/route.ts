import { NextResponse } from "next/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { checkRateLimit } from "@/lib/ratelimit";
import { callForPlayer, markPresentAsPlayer } from "@/lib/matchday/server";

/**
 * "I'm at court": a signed-in player marks themselves present for their own
 * called match (plan Phase 3). Only a match the account plays in, through its
 * claimed player code (player_claims); any other match answers "Not found", the
 * same as one that does not exist.
 *
 *   GET  → { side, imAtCourt, call: { status, calledAt, deadlineAt, presentA, presentB } | null }
 *          | 404: what the phone shows next to the player's own match.
 *   POST → { side, call: { status, calledAt, deadlineAt, presentA, presentB } }
 *          | 404 | 409 { code: no_call | off }. Never the referee's prompt or actions.
 */
export async function GET(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) return privateJson({ error: "Not found" }, 404);
  const rl = await checkRateLimit({ key: `here-read:${owner.id}`, limit: 240, windowSeconds: 600 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds), "Cache-Control": "no-store" } });
  }
  const r = await callForPlayer(owner.id, matchId);
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  return privateJson(r.value);
}

export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) return privateJson({ error: "Not found" }, 404);
  const rl = await checkRateLimit({ key: `here:${owner.id}`, limit: 30, windowSeconds: 600 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds), "Cache-Control": "no-store" } });
  }
  const r = await markPresentAsPlayer(owner.id, matchId);
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  const c = r.value.call;
  return privateJson({ side: r.value.side, call: { status: c.status, calledAt: c.calledAt, deadlineAt: c.deadlineAt, presentA: c.presentA, presentB: c.presentB } });
}
