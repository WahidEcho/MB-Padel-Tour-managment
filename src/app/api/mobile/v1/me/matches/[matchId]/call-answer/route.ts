import { NextResponse } from "next/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { takeRateLimit } from "@/lib/ratelimit";
import { answerCallAsPlayer } from "@/lib/matchday/server";

/**
 * A player answers the call that rang on their phone (owner, 12 Nov 2026; migration 0045):
 *
 *   POST { answer: "coming" | "declined" } → { side, answer }
 *        | 401 signed out | 404 not the account's own match | 409 { code: no_call } not called.
 *
 * Only a match the account plays in, through its claimed player code; "coming" is not "at court"
 * (that stays POST …/here). The chair umpire's call card shows the answer.
 */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) return privateJson({ error: "Not found" }, 404);
  const body = (await request.json().catch(() => null)) as { answer?: unknown } | null;
  if (!body || (body.answer !== "coming" && body.answer !== "declined")) return privateJson({ error: "answer must be coming or declined." }, 400);
  const rl = await takeRateLimit({ key: `call-answer:${owner.id}`, limit: 30, windowSeconds: 600 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds), "Cache-Control": "no-store" } });
  }
  const r = await answerCallAsPlayer(owner.id, matchId, body.answer);
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  return privateJson(r.value);
}
