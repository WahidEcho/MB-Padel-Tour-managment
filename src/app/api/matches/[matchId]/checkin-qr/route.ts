import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { db } from "@/lib/supabase";
import { checkInWindow } from "@/lib/pass/attendance";
import { MATCH_WINDOW_SECONDS, matchCheckinUrl, matchScreenCode } from "@/lib/pass/venueCode";

const noStore = { "Cache-Control": "no-store" };

/**
 * The court TV's corner QR: fans scan it in Move Score to check in to the match
 * being played. The code rotates every MATCH_WINDOW_SECONDS and is only handed
 * out while check-in is open, for a public tournament that has an event pass.
 */
export async function GET(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) return NextResponse.json({ open: false }, { status: 404, headers: noStore });
  const { data: m } = await db().from("matches").select("id, tournament_id, status, scheduled_time, ended_at").eq("id", matchId).maybeSingle();
  const match = m as { id: string; tournament_id: string; status: string; scheduled_time: string | null; ended_at: string | null } | null;
  if (!match) return NextResponse.json({ open: false }, { status: 404, headers: noStore });
  const { data: t } = await db().from("tournaments").select("event_group_id, public_access_enabled").eq("id", match.tournament_id).maybeSingle();
  const tournament = t as { event_group_id: string | null; public_access_enabled: boolean | null } | null;
  const now = Date.now();
  if (!tournament?.public_access_enabled || !tournament.event_group_id || checkInWindow({ status: match.status, scheduledAt: match.scheduled_time, endedAt: match.ended_at }, now).state !== "open") {
    return NextResponse.json({ open: false }, { headers: noStore });
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const origin = `${request.headers.get("x-forwarded-proto") ?? "https"}://${host}`;
  const url = matchCheckinUrl(origin, matchId, { c: matchScreenCode(matchId, now) });
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#05060a", light: "#ffffff" } });
  const left = MATCH_WINDOW_SECONDS - (Math.floor(now / 1000) % MATCH_WINDOW_SECONDS);
  return NextResponse.json({ open: true, url, svg, refreshInSeconds: Math.max(5, left) }, { headers: noStore });
}
