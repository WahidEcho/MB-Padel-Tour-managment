import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { installToken, ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";

const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,80}\]$/;

/**
 * Registers a phone (and its push token). Returns the installation token the
 * phone sends on every personal call. Works without signing in.
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
  const { owner } = await ownerOf(request);
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
  const { error } = await db().from("push_devices").upsert(row, { onConflict: "installation_id" });
  if (error) return NextResponse.json({ error: "Could not register this phone" }, { status: 500 });
  return privateJson({ installToken: installToken(installationId) });
}
