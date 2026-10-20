import { coachJson, coachLineup, coachNotFound, coachRoute } from "@/lib/coaches/server";
import { coachLineupEntry, submitCoachLineup } from "@/lib/coaches/lineups";
import { readJson } from "@/lib/mobile/http";
import { NextResponse } from "next/server";

/**
 * The team's own line-up for one of its ties (never the opponents'). Another team's tie: 404.
 *
 * GET: the line-up as the officials hold it; while the event's coach line-up switch is on
 * (Admin → Team coaches, off by default) also `entry`, the coach's form (own squad, own
 * latest submission, whether it is still open).
 * POST { lineup: { S1, S2, D }, accept?: [<warning key>] } (switch on only, else 409
 * feature_off): the coach submits or changes their team's line-up until the officials
 * confirm (lock) it or the event's deadline passes. 400 problems, 409 warnings to accept
 * (with the regulation) or closed (locked | deadline | under_way), 429 brakes.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ tieId: string }> }) {
  const { tieId } = await params;
  const gate = await coachRoute();
  if (!gate.ok) return gate.response;
  const lineup = await coachLineup(gate.coach, tieId);
  if (!lineup) return coachNotFound();
  const entry = await coachLineupEntry(gate.coach, tieId);
  return coachJson(entry ? { ...lineup, entry } : lineup);
}

export async function POST(request: Request, { params }: { params: Promise<{ tieId: string }> }) {
  const { tieId } = await params;
  const gate = await coachRoute();
  if (!gate.ok) return gate.response;
  const body = await readJson<Record<string, unknown>>(request);
  const out = await submitCoachLineup(gate.coach, tieId, body);
  if (!out.ok) {
    if (out.status === 404) return coachNotFound();
    const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
    if (out.retryAfterSeconds) headers["Retry-After"] = String(out.retryAfterSeconds);
    return NextResponse.json({ error: out.error, code: out.code, problems: out.problems, warnings: out.warnings }, { status: out.status, headers });
  }
  return coachJson({ ok: true, changed: out.changed, entry: out.entry, accepted: out.accepted, officialsAlerted: out.officialsAlerted, exceptionAlerted: out.exceptionAlerted });
}
