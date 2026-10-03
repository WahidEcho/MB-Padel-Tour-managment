/**
 * Brakes and answers shared by the email and player-code sign-in routes.
 *
 * Limits are per network address (generous: a venue shares one Wi-Fi) and per
 * email address. Email addresses are hashed before they become counter keys, so
 * request_counters never holds one in plain text.
 */
import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";

const NO_STORE = { "Cache-Control": "private, no-store" };

export const authJson = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: NO_STORE });

const emailKey = (email: string) => createHash("sha256").update(`ms-email:${email}`).digest("base64url").slice(0, 22);

/** Per-network limit: false (and the caller answers 429) when exceeded. */
export async function ipAllowed(request: Request, name: string, limit: number, windowSeconds: number): Promise<boolean> {
  return (await checkRateLimit({ key: `${name}:ip:${clientIpFrom(request.headers)}`, limit, windowSeconds })).allowed;
}

/** Per-email limit. */
export async function emailAllowed(name: string, email: string, limit: number, windowSeconds: number): Promise<boolean> {
  return (await checkRateLimit({ key: `${name}:e:${emailKey(email)}`, limit, windowSeconds })).allowed;
}

export const tooMany = () => authJson({ error: "Too many tries. Wait a few minutes and try again." }, 429);
export const authUnavailable = () => authJson({ error: "Can't reach sign-in right now. Try again in a moment." }, 503);

/** Supabase answered "try later" (its own rate limits) or not at all. */
export const isTemporary = (e: { status?: number; name?: string } | null | undefined) =>
  !!e && (e.name === "AuthRetryableFetchError" || !e.status || e.status === 429 || e.status >= 500);

// Every answer from the code and email routes that could hint whether an account
// exists takes at least this long.
export async function settle(started: number, minMs = 350) {
  const left = minMs - (Date.now() - started);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}
