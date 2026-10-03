import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/ratelimit";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import { mergeCallersGuestPasses } from "@/lib/pass/server";
import { checkInToMatch } from "@/lib/pass/checkin";

/**
 * Checks the caller's pass in to a match with the code scanned at the court:
 * body { c } (the court TV's rotating code) or { p } (the printed one). Once per
 * pass per match; only while the match is on (src/lib/pass/attendance.ts). The
 * answer is MCheckInReply, or { error, code } (see MCheckInRefusal).
 */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const { owner, installationId } = await ownerOf(request);
  if (!owner) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const rl = await checkRateLimit({ key: `checkin:${installationId ?? owner.id}`, limit: 30, windowSeconds: 600 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds), "Cache-Control": "no-store" } });
  }
  const body = (await readJson<{ c?: string; p?: string }>(request)) ?? {};
  await mergeCallersGuestPasses(request, owner);
  const r = await checkInToMatch(owner, matchId, { c: body.c ?? null, p: body.p ?? null });
  if (!r.ok) return privateJson({ error: r.error, code: r.code, ...(r.opensAt !== undefined ? { opensAt: r.opensAt } : {}) }, r.status);
  return privateJson(r.reply);
}
