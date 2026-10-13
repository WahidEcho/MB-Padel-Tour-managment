/**
 * The public web registration form (a guest, no account): POST
 * { people: [{ name, phone, email }], teamName?, payment?, website } → { ok, message, checkoutUrl, statusUrl }.
 *
 * Defensive like the friendly sessions' public form: a honeypot (`website`),
 * atomic rate limits per network address and per event counted before any work,
 * a small strict body (unknown fields refused), and amounts decided by the server
 * alone. The answer never says whether a phone or email is already known; the
 * status link is signed for this registration only (src/lib/registration/server.ts).
 */
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
  if (typeof body.website === "string" && body.website.trim() !== "") return reply({ ok: true, message: "Registration received.", checkoutUrl: null, statusUrl: null });
  const r = await register({ slug, source: "web", userId: null, people: body.people, teamName: body.teamName, payment: body.payment });
  if (!r.ok) return reply({ ok: false, message: r.status === 404 ? "Registration for this event is not open." : r.error }, r.status === 404 ? 409 : r.status);
  return reply({ ok: true, message: r.value.message, checkoutUrl: r.value.checkoutUrl, statusUrl: returnUrlFor(r.value.registration.id) });
}
