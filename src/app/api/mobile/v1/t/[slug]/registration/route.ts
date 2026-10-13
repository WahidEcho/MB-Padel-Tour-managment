import { NextResponse } from "next/server";
import { clientIpFrom, takeRateLimit } from "@/lib/ratelimit";
import { ownerOf } from "@/lib/mobile/identity";
import { notFoundJson, privateJson, publicJson } from "@/lib/mobile/http";
import { strictBody } from "@/lib/players/http";
import { register, registrationInfo, toPublicRegistration } from "@/lib/registration/server";
import type { MRegistrationResult } from "@/lib/mobile/contract";

/**
 * GET → MRegistrationInfo (public, CDN-cached briefly): how to register for this
 * event, its fee, payment options and refund deadline. Reads no credentials.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const info = await registrationInfo(slug);
  return info ? publicJson(info, 15, 60) : notFoundJson("Not found");
}

/**
 * POST { people: [{ name, phone?, email? }], teamName?, payment? } → MRegistrationResult.
 * A signed-in account registers for the event (its own entry: the registrant is
 * always the account's player). Amounts are the server's own; the answer carries
 * Move Tick's checkout URL when payment is due online now. Rate-limited per account
 * and per network address, counted before the work.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in to register.", code: "sign_in" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const ip = clientIpFrom(request.headers);
  for (const [key, limit, windowSeconds] of [
    [`reg-user:${owner.id}`, 10, 3600],
    [`reg-ip:${ip}`, 30, 3600],
  ] as const) {
    const r = await takeRateLimit({ key, limit, windowSeconds });
    if (!r.allowed) return privateJson({ error: "Too many tries. Wait a little and try again.", code: "too_many" }, 429);
  }
  const body = await strictBody(request, ["people", "teamName", "payment"], 4000);
  if (!body) return privateJson({ error: "That request isn't one this server understands." }, 400);
  const r = await register({ slug, source: "app", userId: owner.id, people: body.people, teamName: body.teamName, payment: body.payment });
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  const { registration, event, org, session, checkoutUrl, message } = r.value;
  const out: MRegistrationResult = { registration: await toPublicRegistration(registration, event, org, session, owner.id), checkoutUrl, message };
  return privateJson(out, 201);
}
