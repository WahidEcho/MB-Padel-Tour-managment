/**
 * The broadcast overlay's numbers for one match: who won each of the last 40
 * points (the momentum line) and the stat boxes (aces or double faults, breaks,
 * points won). Polled by /t/[slug]/overlay/[court] when the score moves.
 *
 * Like the venue TV feed it is never delayed (the overlay is an operator's
 * picture of the court, not a fan surface), public tournaments only, and only
 * numbers: no names, no referee, nothing private.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getOverlayMatchStats } from "@/lib/mobile/stats";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const matchId = new URL(req.url).searchParams.get("match") ?? "";
  const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!UUID.test(matchId)) return notFound();
  const { data } = await db().from("tournaments").select("id, public_access_enabled, kind").eq("slug", slug).maybeSingle();
  const t = data as { id: string; public_access_enabled: boolean; kind: string } | null;
  if (!t || !t.public_access_enabled || t.kind !== "tournament") return notFound();
  const stats = await getOverlayMatchStats(t.id, matchId);
  if (!stats) return notFound();
  return NextResponse.json(stats, { headers: { "Cache-Control": "no-store" } });
}
