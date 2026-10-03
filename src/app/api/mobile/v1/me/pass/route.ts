import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import { createPass, loadPass, mergeCallersGuestPasses, syncFollowPins } from "@/lib/pass/server";

/** The caller's pass for an event: ?group=<event group id>. */
export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  if (!owner) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const group = new URL(request.url).searchParams.get("group") ?? "";
  await mergeCallersGuestPasses(request, owner);
  const pass = group ? await loadPass(group, owner) : null;
  if (pass) await syncFollowPins(pass, owner);
  return privateJson({ pass: pass ? await loadPass(group, owner) : null });
}

const cleanName = (v: unknown) => String(v ?? "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 40) || null;

/**
 * Opens (creates) the pass, or changes its name and nation. Only the fields in the
 * body change: a missing holderName leaves the name alone, an empty one clears it.
 * The pass is always the attendee's: a staff token (older builds sent the referee
 * console's as X-Staff-Token) is ignored, so a phone that once scored a match
 * never turns its holder's pass into a referee accreditation.
 */
export async function POST(request: Request) {
  const { owner } = await ownerOf(request);
  if (!owner) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const body = (await readJson<{ group?: string; holderName?: string | null; nationCode?: string | null }>(request)) ?? {};
  const group = String(body.group ?? "");
  const { data: g } = await db().from("event_groups").select("id").eq("id", group).maybeSingle();
  if (!g) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  await mergeCallersGuestPasses(request, owner);
  const hasName = Object.prototype.hasOwnProperty.call(body, "holderName");
  const holderName = hasName ? cleanName(body.holderName) : null;
  const nationCode = /^[A-Z]{3}$/.test(String(body.nationCode ?? "")) ? String(body.nationCode) : null;
  const pass = await createPass(group, owner, { holderName, nationCode });
  if (!pass) return NextResponse.json({ error: "Could not open the pass" }, { status: 500 });
  // Name and nation can be changed later; the serial cannot.
  const patch: { holder_name?: string | null; nation_code?: string } = {};
  if (hasName && holderName !== pass.holderName) patch.holder_name = holderName;
  if (nationCode && nationCode !== pass.nationCode) patch.nation_code = nationCode;
  if (Object.keys(patch).length) await db().from("event_passes").update(patch).eq("id", pass.id);
  const fresh = await loadPass(group, owner);
  if (fresh) await syncFollowPins(fresh, owner);
  return privateJson({ pass: await loadPass(group, owner) });
}
