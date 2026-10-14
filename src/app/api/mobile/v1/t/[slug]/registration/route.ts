import { NextResponse } from "next/server";
import { clientIpFrom, takeRateLimit } from "@/lib/ratelimit";
import { ownerOf } from "@/lib/mobile/identity";
import { notFoundJson, privateJson, publicJson } from "@/lib/mobile/http";
import { strictBody } from "@/lib/players/http";
import { register, registrationInfo, toPublicRegistration } from "@/lib/registration/server";
import { bearerOf, getAuthUser } from "@/lib/auth/accounts";
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
 * POST { people: [{ name, phone?, email? }], teamName?, payment?, entryType? } → MRegistrationResult.
 * A signed-in account registers for the event (its own entry: the registrant is
 * always the account's player). Only an account with a confirmed email may: an
 * anonymous (player-code) or unconfirmed account is refused (403 email_required),
 * so nobody can register — or be sent messages — under throwaway accounts. That
 * confirmed email, read from Supabase Auth (never the typed one), is the only
 * address the entry's messages go to. Amounts are the server's own. Registering
 * opens no checkout (that takes a place): the app calls /me/registrations/{id}/pay
 * next when the answer's registration says canPay. Rate-limited per
 * account and per network address, counted before the work.
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
  const body = await strictBody(request, ["people", "teamName", "payment", "entryType"], 4000);
  if (!body) return privateJson({ error: "That request isn't one this server understands." }, 400);
  const token = bearerOf(request);
  const who = token ? await getAuthUser(token) : null;
  if (!who?.ok) return privateJson({ error: "Could not check your account right now. Try again.", code: "account_unreachable" }, 503);
  if (who.data.id !== owner.id || who.data.is_anonymous || !who.data.email || !who.data.email_confirmed_at) {
    return privateJson({ error: "Add and confirm your email address in Account to register.", code: "email_required" }, 403);
  }
  const verifiedEmail = who.data.email.trim().toLowerCase();
  const r = await register({ slug, source: "app", userId: owner.id, verifiedEmail, people: body.people, teamName: body.teamName, payment: body.payment, entryType: body.entryType });
  if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
  const { registration, event, org, session, checkoutUrl, message } = r.value;
  const out: MRegistrationResult = { registration: await toPublicRegistration(registration, event, org, session, owner.id), checkoutUrl, message };
  return privateJson(out, 201);
}
