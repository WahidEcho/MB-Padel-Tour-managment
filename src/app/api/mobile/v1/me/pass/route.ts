import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { verifySessionToken } from "@/lib/auth";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import { createPass, loadPass, syncFollowPins } from "@/lib/pass/server";

/** The caller's pass for an event: ?group=<event group id>. */
export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  if (!owner) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const group = new URL(request.url).searchParams.get("group") ?? "";
  const pass = group ? await loadPass(group, owner) : null;
  if (pass) await syncFollowPins(pass, owner);
  return privateJson({ pass: pass ? await loadPass(group, owner) : null });
}

/**
 * Opens (creates) the pass. A phone signed in with a staff code sends that token
 * as X-Staff-Token and gets the accreditation edition with its role on it.
 */
export async function POST(request: Request) {
  const { owner } = await ownerOf(request);
  if (!owner) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const body = await readJson<{ group?: string; holderName?: string; nationCode?: string }>(request);
  const group = String(body?.group ?? "");
  const { data: g } = await db().from("event_groups").select("id").eq("id", group).maybeSingle();
  if (!g) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  const staffRole = verifySessionToken(request.headers.get("x-staff-token") ?? undefined);
  const holderName = String(body?.holderName ?? "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 40) || null;
  const nationCode = /^[A-Z]{3}$/.test(String(body?.nationCode ?? "")) ? String(body!.nationCode) : null;
  const pass = await createPass(group, owner, { holderName, nationCode, staffRole });
  if (!pass) return NextResponse.json({ error: "Could not open the pass" }, { status: 500 });
  // Name and nation can be changed later; the serial and edition cannot.
  if (holderName !== pass.holderName || (nationCode && nationCode !== pass.nationCode)) {
    await db().from("event_passes").update({ holder_name: holderName, ...(nationCode ? { nation_code: nationCode } : {}) }).eq("id", pass.id);
  }
  const fresh = await loadPass(group, owner);
  if (fresh) await syncFollowPins(fresh, owner);
  return privateJson({ pass: await loadPass(group, owner) });
}
