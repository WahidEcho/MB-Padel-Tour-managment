import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { verifyInstallToken } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import { checkRateLimit } from "@/lib/ratelimit";
import { parseStartTokenBody } from "@/lib/notify/liveActivity";

/** A token body is ~200 bytes; anything far larger is not ours. */
const MAX_BODY_BYTES = 2048;

/**
 * This iPhone's Live Activity push-to-start token (iOS 17.2+), which lets the
 * server put a match's card on the lock screen without the app running
 * (pushToStart in src/lib/notify/apns.ts). One per installation; the phone sends
 * it whenever iOS hands it a new one. Never logged, never returned.
 *
 *   POST   { token }  registers or replaces it
 *   DELETE            stops cards started by push on this phone
 */
export async function POST(request: Request) {
  const install = verifyInstallToken(request.headers.get("x-install-token"));
  if (!install) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const rl = await checkRateLimit({ key: `la-start-token:${install}`, limit: 30, windowSeconds: 3600 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return NextResponse.json({ error: "Body too large" }, { status: 413 });
  const parsed = parseStartTokenBody(await readJson<unknown>(request));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // A token moves with a reinstall (new installation id, same phone): free it from the old row first.
  await db().from("live_activity_start_tokens").delete().eq("token", parsed.token).neq("installation_id", install);
  const { error } = await db()
    .from("live_activity_start_tokens")
    .upsert({ installation_id: install, token: parsed.token, updated_at: new Date().toISOString(), disabled_at: null }, { onConflict: "installation_id" });
  if (error) {
    console.error("[live-activity] start token not saved", error.code ?? "", error.message.replace(/[0-9a-f]{40,}/gi, "…"));
    return NextResponse.json({ error: "Could not register" }, { status: 500 });
  }
  return privateJson({ ok: true });
}

export async function DELETE(request: Request) {
  const install = verifyInstallToken(request.headers.get("x-install-token"));
  if (!install) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  await db().from("live_activity_start_tokens").update({ disabled_at: new Date().toISOString() }).eq("installation_id", install);
  return privateJson({ ok: true });
}
