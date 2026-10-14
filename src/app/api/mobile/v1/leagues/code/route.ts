import { NextResponse } from "next/server";
import { revealLeagueByCode } from "@/lib/leagues/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import type { MLeagueReveal } from "@/lib/mobile/contract";

/**
 * POST { code } → MLeagueReveal. A signed-in account enters a league's invite
 * code: the league it belongs to opens for this account (an 'Invite only' league
 * included) until the organiser changes or clears the code. Guesses share
 * joining's rate limit per account; the code is never logged. A wrong code is a
 * 404 { code: "invite_code_wrong" }.
 */
export async function POST(request: Request) {
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in to enter an invite code.", code: "sign_in" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const body = (await readJson<Record<string, unknown>>(request)) ?? {};
  if (Object.keys(body).some((k) => k !== "code")) return privateJson({ error: "Send the code only." }, 400);
  if (typeof body.code !== "string" || body.code.length > 40) return privateJson({ error: "That invite code doesn't look right." }, 400);
  const r = await revealLeagueByCode(owner.id, body.code);
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  const out: MLeagueReveal = r.league;
  return privateJson(out);
}
