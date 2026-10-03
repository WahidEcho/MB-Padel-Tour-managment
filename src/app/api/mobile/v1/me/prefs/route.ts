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
  return privateJson({ prefs: { ...DEFAULT_ALERT_PREFS, ...((data as { prefs?: Partial<MAlertPrefs> } | null)?.prefs ?? {}) } });
}

export async function PATCH(request: Request) {
  const { installationId } = await ownerOf(request);
  if (!installationId) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const body = await readJson<Partial<MAlertPrefs>>(request);
  const prefs: MAlertPrefs = { ...DEFAULT_ALERT_PREFS };
  for (const k of Object.keys(prefs) as (keyof MAlertPrefs)[]) if (typeof body?.[k] === "boolean") prefs[k] = body[k] as boolean;
  const { error } = await db().from("push_devices").update({ prefs }).eq("installation_id", installationId);
  if (error) return NextResponse.json({ error: "Could not save alert settings" }, { status: 500 });
  return privateJson({ prefs });
}
