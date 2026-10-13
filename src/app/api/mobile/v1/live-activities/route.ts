import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { verifyInstallToken } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import { APNS_TOKEN } from "@/lib/notify/liveActivity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Registers (POST) or ends (DELETE) an iPhone lock-screen live score for one match. */
export async function POST(request: Request) {
  const install = verifyInstallToken(request.headers.get("x-install-token"));
  if (!install) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const body = await readJson<{ matchId?: string; pushToken?: string }>(request);
  // Cards started by push register here too (the app reads the match from the card's link).
  if (!UUID.test(String(body?.matchId ?? "")) || !APNS_TOKEN.test(String(body?.pushToken ?? ""))) {
    return NextResponse.json({ error: "matchId and pushToken required" }, { status: 400 });
  }
  const { error } = await db()
    .from("live_activity_tokens")
    .upsert({ installation_id: install, match_id: body!.matchId, push_token: String(body!.pushToken).toLowerCase(), ended_at: null }, { onConflict: "push_token" });
  if (error) return NextResponse.json({ error: "Could not register" }, { status: 500 });
  return privateJson({ ok: true });
}

export async function DELETE(request: Request) {
  const install = verifyInstallToken(request.headers.get("x-install-token"));
  if (!install) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const body = await readJson<{ pushToken?: string }>(request);
  await db().from("live_activity_tokens").update({ ended_at: new Date().toISOString() }).eq("push_token", String(body?.pushToken ?? "")).eq("installation_id", install);
  return privateJson({ ok: true });
}
