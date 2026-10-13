/**
 * The public web registration form (a guest, no account): POST
 * { people: [{ name, phone, email }], teamName?, payment?, website } → { ok, message, checkoutUrl, statusUrl }.
 *
 * Defensive like the friendly sessions' public form: a honeypot (`website`),
 * atomic rate limits per network address, per event and per email address typed
 * (the one address the form can make Move Score write to), counted before any work,
 * a small strict body (unknown fields refused), and amounts decided by the server
 * alone. The entry waits as "unconfirmed" until the link emailed to that address
 * is opened (/register/confirm): until then it holds no place and reaches no
 * organiser, and the address gets nothing else. The answer never says whether a
 * phone or email is already known; the status link is signed for this
 * registration only and cannot confirm it (src/lib/registration/server.ts).
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { clientIpFrom, takeRateLimit } from "@/lib/ratelimit";
import { strictBody } from "@/lib/players/http";
import { register, returnUrlFor } from "@/lib/registration/server";
import { sameOrigin } from "@/lib/orgs/invites";

export const dynamic = "force-dynamic";

const reply = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // A browser posting from another site's page is refused (a script without an Origin header is rate-limited like anyone).
  if (request.headers.get("origin") && !sameOrigin(request)) return reply({ ok: false, message: "Open the form on this site to register." }, 403);
  const ip = clientIpFrom(request.headers);
  for (const [key, limit, windowSeconds] of [
    [`reg-web-ip:${ip}`, 5, 600],
    [`reg-web-event:${slug.slice(0, 120)}`, 200, 3600],
  ] as const) {
    const r = await takeRateLimit({ key, limit, windowSeconds });
    if (!r.allowed) return reply({ ok: false, message: "Too many attempts. Please try again shortly." }, 429);
  }
  const body = await strictBody(request, ["people", "teamName", "payment", "website"], 4000);
  if (!body) return reply({ ok: false, message: "Invalid request." }, 400);
  // Honeypot: hidden on the real form. Same answer as a real registration, nothing written.
  if (typeof body.website === "string" && body.website.trim() !== "") return reply({ ok: true, message: "Almost done: we emailed you a link. Open it within 24 hours to confirm your registration.", checkoutUrl: null, statusUrl: null });
  // The typed address is the one this form can make Move Score write to: a few links a day at most.
  const first = Array.isArray(body.people) ? (body.people[0] as { email?: unknown } | null) : null;
  const typed = typeof first?.email === "string" ? first.email.trim().toLowerCase().slice(0, 200) : "";
  if (typed) {
    const key = `reg-web-contact:${createHash("sha256").update(typed).digest("hex").slice(0, 40)}`;
    const r = await takeRateLimit({ key, limit: 3, windowSeconds: 86400 });
    if (!r.allowed) return reply({ ok: false, message: "Too many attempts. Please try again shortly." }, 429);
  }
  const r = await register({ slug, source: "web", userId: null, verifiedEmail: null, people: body.people, teamName: body.teamName, payment: body.payment });
  if (!r.ok) return reply({ ok: false, message: r.status === 404 ? "Registration for this event is not open." : r.error }, r.status === 404 ? 409 : r.status);
  return reply({ ok: true, message: r.value.message, checkoutUrl: r.value.checkoutUrl, statusUrl: returnUrlFor(r.value.registration.id) });
}
