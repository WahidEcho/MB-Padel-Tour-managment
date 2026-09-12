/**
 * Public self-registration for a friendly session.
 *
 * This is the only unauthenticated write endpoint in the app, so it is
 * deliberately defensive:
 *  - rate limited per IP+session and per session overall,
 *  - a honeypot field that real users never fill in,
 *  - strict payload validation and size caps,
 *  - and an opaque response. It must never reveal whether a mobile number
 *    already belongs to a player, whether that player was already registered,
 *    or whether they landed on the waitlist. Duplicate handling is admin-only.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { registerForSession } from "@/lib/friendly/ops";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_000;

/** One response shape for every non-validation outcome. */
const OPAQUE_OK = { ok: true, message: "Registration received. An organiser will confirm your place." };

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, message: "Request too large." }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  // Honeypot: hidden on the real form, so anything here is a bot. Answer with
  // the normal success shape so the bot learns nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return NextResponse.json(OPAQUE_OK);
  }

  const ip = clientIpFrom(req.headers);
  const perIp = await checkRateLimit({
    key: `register:${slug}:${ip}`,
    limit: 5,
    windowSeconds: 600,
  });
  if (!perIp.allowed) {
    return NextResponse.json(
      { ok: false, message: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(perIp.retryAfterSeconds) } }
    );
  }

  // Session-wide brake, so one session cannot be flooded from many addresses.
  const perSession = await checkRateLimit({
    key: `register-session:${slug}`,
    limit: 200,
    windowSeconds: 3600,
  });
  if (!perSession.allowed) {
    return NextResponse.json(
      { ok: false, message: "Registration is busy right now. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(perSession.retryAfterSeconds) } }
    );
  }

  const { data: session } = await db()
    .from("friendly_sessions")
    .select("id, status, registration_mode")
    .eq("slug", slug)
    .maybeSingle();

  // Unknown slug and closed session are answered identically so the endpoint
  // cannot be used to enumerate sessions.
  if (!session || session.status !== "open") {
    return NextResponse.json(
      { ok: false, message: "Registration for this session is not open." },
      { status: 409 }
    );
  }

  const str = (v: unknown, max = 80) => (typeof v === "string" ? v.slice(0, max) : "");
  const publicName = str(body.public_name);
  const mobile = str(body.mobile, 40);
  const consentWhatsapp = body.consent_whatsapp === true;

  // A team submission carries the partner inline, so one form creates both.
  const partnerName = str(body.partner_name);
  const partnerMobile = str(body.partner_mobile, 40);
  const wantsTeam = Boolean(partnerName || partnerMobile);

  const result = await registerForSession({
    sessionId: session.id,
    publicName,
    mobile,
    consentWhatsapp,
    partner: wantsTeam ? { publicName: partnerName, mobile: partnerMobile } : null,
    teamName: str(body.team_name) || null,
  });

  if (!result.ok) {
    // Only failures the submitter can actually fix are distinguished; anything
    // that would reveal session state collapses into the same closed message.
    const messages: Record<string, string> = {
      invalid_name: "Please enter your full name.",
      invalid_mobile: "Please enter a valid mobile number.",
      invalid_partner: "Please enter your partner's name and a valid mobile number.",
      same_person: "You and your partner need different mobile numbers.",
      team_not_allowed: "This session takes individual sign-ups only.",
      individual_not_allowed: "This session takes team sign-ups only — add your partner's details.",
    };
    const message = messages[result.reason] ?? "Registration for this session is not open.";
    return NextResponse.json(
      { ok: false, message },
      { status: result.reason === "closed" ? 409 : 400 }
    );
  }

  return NextResponse.json(OPAQUE_OK);
}
