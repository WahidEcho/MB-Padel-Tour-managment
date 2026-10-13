import { NextResponse } from "next/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { myRegistrations } from "@/lib/registration/server";
import type { MMyRegistrations } from "@/lib/mobile/contract";

/** GET → MMyRegistrations: the signed-in account's own registrations, newest first. Never cached. */
export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const out: MMyRegistrations = { registrations: await myRegistrations(owner.id) };
  return privateJson(out);
}
