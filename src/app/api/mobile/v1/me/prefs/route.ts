import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import { DEFAULT_ALERT_PREFS, type MAlertPrefs } from "@/lib/mobile/contract";

/** Which kinds of alert this phone gets. */
export async function GET(request: Request) {
  const { installationId } = await ownerOf(request);
  if (!installationId) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const { data } = await db().from("push_devices").select("prefs").eq("installation_id", installationId).maybeSingle();
  return privateJson({ prefs: { ...DEFAULT_ALERT_PREFS, ...pickPrefs((data as { prefs?: Record<string, unknown> } | null)?.prefs ?? {}) } });
}

/**
 * Changes only the kinds named in the body. Kinds left out, and kinds this server
 * stores that an older app does not know about (e.g. `court`), keep their saved
 * values: an app that predates a kind must never switch it back to the default.
 */
export async function PATCH(request: Request) {
  const { installationId } = await ownerOf(request);
  if (!installationId) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const body = await readJson<Record<string, unknown>>(request);
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
    return NextResponse.json({ error: "Send the alert kinds as an object" }, { status: 400 });
  }
  const { data } = await db().from("push_devices").select("prefs").eq("installation_id", installationId).maybeSingle();
  const stored = ((data as { prefs?: Record<string, unknown> } | null)?.prefs ?? {}) as Record<string, unknown>;
  const changes: Partial<MAlertPrefs> = {};
  for (const k of Object.keys(DEFAULT_ALERT_PREFS) as (keyof MAlertPrefs)[]) if (typeof body?.[k] === "boolean") changes[k] = body[k] as boolean;
  const saved = { ...stored, ...changes };
  const { error } = await db().from("push_devices").update({ prefs: saved }).eq("installation_id", installationId);
  if (error) return NextResponse.json({ error: "Could not save alert settings" }, { status: 500 });
  return privateJson({ prefs: { ...DEFAULT_ALERT_PREFS, ...pickPrefs(saved) } });
}

/** Only the known kinds, and only booleans, go back to the phone. */
function pickPrefs(raw: Record<string, unknown>): Partial<MAlertPrefs> {
  const out: Partial<MAlertPrefs> = {};
  for (const k of Object.keys(DEFAULT_ALERT_PREFS) as (keyof MAlertPrefs)[]) if (typeof raw[k] === "boolean") out[k] = raw[k] as boolean;
  return out;
}
