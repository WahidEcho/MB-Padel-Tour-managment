import { NextResponse, after } from "next/server";
import { staffRoute } from "@/lib/guard";
import { answerNoShow, callToCourt, cancelCall, extendCall, getCall, markPresent, type NoShowAnswer } from "@/lib/matchday/server";

/**
 * Calling a match to its court (plan Phase 3, src/lib/matchday/server.ts).
 *
 *   GET  → { call: CallState | null, rules: CallRules }
 *   POST { action: "call", force? }                 → 201 called, 200 already called;
 *                                                     409 court_busy unless force
 *        { action: "present", side: "A" | "B" }      → the side is at the court
 *        { action: "extend" }                        → +N min at the no-show prompt
 *        { action: "answer", answer, deviceId? }     → wait | walkover_to_a | walkover_to_b | both_no_show
 *        { action: "cancel" }                        → withdraw the call
 *
 * Staff only (score_match: admin, manager, referee). The match's own tournament
 * decides the organisation (and an event code's scope): another organisation's
 * match is the same 404 as a missing one. Answers carry no player data.
 */
const NO_STORE = { "Cache-Control": "private, no-store" };
const ACTIONS = new Set(["call", "present", "extend", "answer", "cancel"]);
const ANSWERS = new Set<NoShowAnswer>(["wait", "walkover_to_a", "walkover_to_b", "both_no_show"]);
const KEYS = new Set(["action", "force", "side", "answer", "deviceId"]);

export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const gate = await staffRoute("score_match", { match: matchId });
  if (!gate.ok) return gate.response;
  const out = await getCall(matchId);
  if (!out) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  return NextResponse.json(out, { headers: NO_STORE });
}

export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const gate = await staffRoute("score_match", { match: matchId });
  if (!gate.ok) return gate.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const bad = (error: string) => NextResponse.json({ error }, { status: 400, headers: NO_STORE });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Send a JSON object.");
  if (Object.keys(body).some((k) => !KEYS.has(k))) return bad("Unknown field.");
  const action = body.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) return bad("action must be call, present, extend, answer or cancel.");
  const role = gate.staff.role;

  let out;
  switch (action) {
    case "call":
      if (body.force !== undefined && typeof body.force !== "boolean") return bad("force must be true or false.");
      out = await callToCourt(matchId, { role, force: body.force === true });
      break;
    case "present":
      if (body.side !== "A" && body.side !== "B") return bad("side must be A or B.");
      out = await markPresent(matchId, body.side, { by: "referee", role });
      break;
    case "extend":
      out = await extendCall(matchId, { role });
      break;
    case "answer": {
      if (typeof body.answer !== "string" || !ANSWERS.has(body.answer as NoShowAnswer)) return bad("answer must be wait, walkover_to_a, walkover_to_b or both_no_show.");
      if (body.deviceId !== undefined && (typeof body.deviceId !== "string" || body.deviceId.length > 100)) return bad("deviceId must be a short string.");
      out = await answerNoShow(matchId, body.answer as NoShowAnswer, { role, deviceId: (body.deviceId as string | undefined) ?? null, defer: (task) => after(task) });
      break;
    }
    default:
      out = await cancelCall(matchId, { role });
  }
  if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status, headers: NO_STORE });
  return NextResponse.json(out.value, { status: out.status, headers: NO_STORE });
}
