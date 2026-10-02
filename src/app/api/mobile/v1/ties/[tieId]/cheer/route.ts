import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { verifyInstallToken } from "@/lib/mobile/identity";
import { readJson } from "@/lib/mobile/http";

/**
 * Tap-to-cheer. Phones batch taps and send a count every few seconds; one phone
 * adds at most 30 per call and 40 calls an hour, and one network address 600 calls
 * an hour, so the meter reflects people, not scripts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tieId: string }> }) {
  const install = verifyInstallToken(request.headers.get("x-install-token"));
  if (!install) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const { tieId } = await params;
  const body = await readJson<{ nation?: string; n?: number }>(request);
  const nation = String(body?.nation ?? "");
  const n = Math.max(1, Math.min(30, Math.floor(Number(body?.n) || 1)));
  if (!/^[A-Z]{3}$/.test(nation)) return NextResponse.json({ error: "nation required" }, { status: 400 });
  const rl = await checkRateLimit({ key: `cheer:${install}`, limit: 40, windowSeconds: 3600 });
  if (!rl.allowed) return NextResponse.json({ ok: false, throttled: true }, { status: 429 });
  // Per address too, since installs are free to make; generous because a stand on venue Wi-Fi shares one.
  const perIp = await checkRateLimit({ key: `cheer-ip:${clientIpFrom(request.headers)}`, limit: 600, windowSeconds: 3600 });
  if (!perIp.allowed) return NextResponse.json({ ok: false, throttled: true }, { status: 429 });
  const { data: tie } = await db().from("ties").select("id, status").eq("id", tieId).maybeSingle();
  if (!tie || (tie as { status: string }).status === "completed") return NextResponse.json({ ok: false }, { status: 409 });
  const { data: row } = await db().from("tie_cheers").select("count").eq("tie_id", tieId).eq("nation_code", nation).maybeSingle();
  const count = Number((row as { count?: number } | null)?.count ?? 0) + n;
  await db().from("tie_cheers").upsert({ tie_id: tieId, nation_code: nation, count, updated_at: new Date().toISOString() }, { onConflict: "tie_id,nation_code" });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
