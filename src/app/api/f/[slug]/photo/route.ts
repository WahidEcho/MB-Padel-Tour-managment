/**
 * Public photo upload for a friendly-session registration.
 *
 * The second unauthenticated write endpoint in the app, so it is as defensive
 * as the registration route it sits beside:
 *  - rate limited per IP and per session,
 *  - a 2 MB cap refused from Content-Length before anything is buffered,
 *  - raster types only, verified by magic bytes rather than the declared type,
 *  - stored under a `pending/` prefix so uploads from registrations nobody ever
 *    approves are separable from the real roster.
 *
 * Nothing here makes a face public. A pending profile's photo is withheld at
 * the read boundary (`listPublicPlayers`) until an admin approves the player,
 * so a bogus registration cannot put an image on the venue wall.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { PHOTO_TYPES, uploadImage } from "@/lib/upload";

export const dynamic = "force-dynamic";

/** Deliberately well below the staff limit: a phone photo compresses fine. */
const MAX_BYTES = 2 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;

  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BYTES + 4096) {
    return NextResponse.json(
      { ok: false, message: "That photo is over 2 MB. Please pick a smaller one." },
      { status: 413 },
    );
  }

  // Only sessions that are actually open to registration accept uploads.
  const { data: session } = await db()
    .from("friendly_sessions")
    .select("id, status")
    .eq("slug", slug)
    .maybeSingle();
  if (!session || session.status !== "open") {
    return NextResponse.json({ ok: false, message: "Registration is closed." }, { status: 404 });
  }

  const ip = clientIpFrom(req.headers);
  for (const [key, limit, windowSeconds] of [
    [`photo:${slug}:${ip}`, 5, 600],
    [`photo:${slug}`, 120, 3600],
  ] as const) {
    const result = await checkRateLimit({ key, limit, windowSeconds });
    if (!result.allowed) {
      return NextResponse.json(
        { ok: false, message: "Too many uploads. Please try again shortly." },
        { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
      );
    }
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, message: "No photo received." }, { status: 400 });
  }

  try {
    const url = await uploadImage(file, `pending/${session.id}`, {
      allow: PHOTO_TYPES,
      maxBytes: MAX_BYTES,
    });
    return NextResponse.json({ ok: true, url });
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 400 });
  }
}
