import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { checkRateLimit } from "@/lib/ratelimit";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import { checkVenueCode, eventDay } from "@/lib/pass/venueCode";
import { createPass, loadPass } from "@/lib/pass/server";

/**
 * Scanning the venue code: upgrades the pass to the on-site edition and stamps
 * today. Proof of being there is the rotating code (a posted photo expires), plus
 * the phone being in the event's country by its network address.
 */
export async function POST(request: Request) {
  const { owner, installationId } = await ownerOf(request);
  if (!owner) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const rl = await checkRateLimit({ key: `unlock:${installationId ?? owner.id}`, limit: 20, windowSeconds: 600 });
  if (!rl.allowed) return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429 });
  const body = await readJson<{ groupSlug?: string; code?: string }>(request);
  const { data: g } = await db().from("event_groups").select("id, slug, timezone, country_code").eq("slug", String(body?.groupSlug ?? "")).maybeSingle();
  const group = g as { id: string; slug: string; timezone: string; country_code: string | null } | null;
  if (!group) return NextResponse.json({ error: "That code is not for an event in Move Score." }, { status: 404 });
  const country = request.headers.get("x-vercel-ip-country");
  if (group.country_code && country && country.toUpperCase() !== group.country_code.toUpperCase()) {
    return NextResponse.json({ error: "Scan the code at the venue to unlock the on-site edition." }, { status: 403 });
  }
  if (!checkVenueCode(group.slug, String(body?.code ?? ""), group.timezone)) {
    return NextResponse.json({ error: "That code has expired. Scan the screen at the gate again." }, { status: 400 });
  }
  const pass = (await loadPass(group.id, owner)) ?? (await createPass(group.id, owner, { holderName: null, nationCode: null, staffRole: null }));
  if (!pass) return NextResponse.json({ error: "Could not open the pass" }, { status: 500 });
  const day = eventDay(group.timezone);
  await db().from("pass_stamps").upsert({ pass_id: pass.id, day }, { onConflict: "pass_id,day", ignoreDuplicates: true });
  if (!pass.onsiteUnlockedAt) await db().from("event_passes").update({ onsite_unlocked_at: new Date().toISOString() }).eq("id", pass.id);
  if (pass.nationCode) {
    await db().from("pass_pins").upsert({ pass_id: pass.id, pin_code: pass.nationCode, source: "onsite" }, { onConflict: "pass_id,pin_code", ignoreDuplicates: true });
  }
  return privateJson({ pass: await loadPass(group.id, owner), stampedDay: day });
}
