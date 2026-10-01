import { NextResponse } from "next/server";
import { can, currentRole } from "@/lib/auth";
import { refereeBootstrap } from "@/lib/referee/bootstrap";

export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const role = await currentRole();
  if (!can(role, "score_match")) return NextResponse.json({ error: "Sign in with the referee code" }, { status: 403 });
  const { matchId } = await params;
  const data = await refereeBootstrap(matchId);
  if (!data) return NextResponse.json({ error: "Match not found or its teams are not set" }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
