import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { verifySessionToken } from "@/lib/auth";
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
 * A phone signed in with a staff code sends that token as X-Staff-Token and gets
 * (or is upgraded to) the accreditation edition with its role on it.
 */
export async function POST(request: Request) {
  const { owner } = await ownerOf(request);
  if (!owner) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const body = (await readJson<{ group?: string; holderName?: string | null; nationCode?: string | null }>(request)) ?? {};
  const group = String(body.group ?? "");
  const { data: g } = await db().from("event_groups").select("id").eq("id", group).maybeSingle();
  if (!g) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  await mergeCallersGuestPasses(request, owner);
  const staffRole = verifySessionToken(request.headers.get("x-staff-token") ?? undefined);
  const hasName = Object.prototype.hasOwnProperty.call(body, "holderName");
  const holderName = hasName ? cleanName(body.holderName) : null;
  const nationCode = /^[A-Z]{3}$/.test(String(body.nationCode ?? "")) ? String(body.nationCode) : null;
  const pass = await createPass(group, owner, { holderName, nationCode, staffRole });
  if (!pass) return NextResponse.json({ error: "Could not open the pass" }, { status: 500 });
  // Name and nation can be changed later; the serial cannot, and the edition only goes up.
  const patch: { holder_name?: string | null; nation_code?: string } = {};
  if (hasName && holderName !== pass.holderName) patch.holder_name = holderName;
  if (nationCode && nationCode !== pass.nationCode) patch.nation_code = nationCode;
  if (Object.keys(patch).length) await db().from("event_passes").update(patch).eq("id", pass.id);
  const fresh = await loadPass(group, owner);
  if (fresh) await syncFollowPins(fresh, owner);
  return privateJson({ pass: await loadPass(group, owner) });
}
