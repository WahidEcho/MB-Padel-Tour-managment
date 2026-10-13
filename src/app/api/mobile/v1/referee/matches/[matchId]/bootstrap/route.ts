import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { refereeBootstrap } from "@/lib/referee/bootstrap";

export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  // The match's own tournament decides the organisation (and an event code's scope).
  const gate = await staffRoute("score_match", { match: matchId });
  if (!gate.ok) return gate.response;
  const data = await refereeBootstrap(matchId);
  if (!data) return NextResponse.json({ error: "Match not found or its teams are not set" }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
