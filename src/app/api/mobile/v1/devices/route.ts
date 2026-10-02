import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { mintInstallToken, ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";

const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,80}\]$/;

/**
 * Registers a phone (and its push token). Returns the installation token the
 * phone sends on every personal call. Works without signing in.
 *
 * A token is minted only for an installation id nobody has registered yet. Once
 * registered, an id is updated only by a caller presenting its token (push-token
 * refresh, signing in or out); anyone else asking for it gets 409, and the app
 * picks a fresh id. Without a signed-in user, a re-registration unlinks the phone
 * from any account, so signing out stops that account's alerts here.
 */
export async function POST(request: Request) {
  const ip = clientIpFrom(request.headers);
  const rl = await checkRateLimit({ key: `devices:${ip}`, limit: 300, windowSeconds: 3600 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const body = await readJson<{
    installationId?: string;
    platform?: string;
    expoPushToken?: string | null;
    appVersion?: string;
    tz?: string;
    locale?: string;
  }>(request);
  const installationId = String(body?.installationId ?? "");
  if (!/^[A-Za-z0-9-]{16,80}$/.test(installationId)) return NextResponse.json({ error: "installationId required" }, { status: 400 });
  const platform = body?.platform === "android" ? "android" : body?.platform === "ios" ? "ios" : null;
  if (!platform) return NextResponse.json({ error: "platform must be ios or android" }, { status: 400 });
  const token = body?.expoPushToken && EXPO_TOKEN.test(body.expoPushToken) ? body.expoPushToken : null;
  const { owner, installationId: presented } = await ownerOf(request);
  const known = presented === installationId;

  if (!known) {
    // Minting is the expensive thing to script; a venue's shared address still fits plenty of new phones.
    const fresh = await checkRateLimit({ key: `devices-new:${ip}`, limit: 60, windowSeconds: 3600 });
    if (!fresh.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    const { data: taken } = await db().from("push_devices").select("installation_id").eq("installation_id", installationId).maybeSingle();
    if (taken) return NextResponse.json({ error: "This installation is already registered", code: "install_taken" }, { status: 409 });
  }

  const row: Record<string, unknown> = {
    installation_id: installationId,
    platform,
    app_version: String(body?.appVersion ?? "").slice(0, 20) || null,
    tz: String(body?.tz ?? "").slice(0, 60) || null,
    locale: String(body?.locale ?? "").slice(0, 20) || null,
    last_seen_at: new Date().toISOString(),
    disabled_at: null,
  };
  if (token) {
    // A push token moves with a reinstall: free it from any older row first.
    await db().from("push_devices").update({ expo_push_token: null }).eq("expo_push_token", token).neq("installation_id", installationId);
    row.expo_push_token = token;
  }
  if (owner?.kind === "user") row.user_id = owner.id;
  // No session presented at all: signed out on this phone. (A session that fails to verify leaves the link alone.)
  else if (!request.headers.get("authorization")?.replace(/^bearer\s*/i, "").trim()) row.user_id = null;

  if (known) {
    const { error } = await db().from("push_devices").upsert(row, { onConflict: "installation_id" });
    if (error) return NextResponse.json({ error: "Could not register this phone" }, { status: 500 });
    return privateJson({ installToken: request.headers.get("x-install-token") });
  }
  const { error } = await db().from("push_devices").insert(row);
  if (error) {
    // Two first registrations of the same id at once: the loser is told to pick another.
    const { data: raced } = await db().from("push_devices").select("installation_id").eq("installation_id", installationId).maybeSingle();
    if (raced) return NextResponse.json({ error: "This installation is already registered", code: "install_taken" }, { status: 409 });
    return NextResponse.json({ error: "Could not register this phone" }, { status: 500 });
  }
  return privateJson({ installToken: mintInstallToken(installationId) });
}
