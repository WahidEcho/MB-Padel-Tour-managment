import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { QR_LINKS_KEY, parseQrLinks } from "@/lib/platform/qrLinks";

export const dynamic = "force-dynamic";

/**
 * A printed QR code's permanent address. Forwards to the code's current target
 * with a temporary redirect (never cached by phones), so changing the target in
 * the admin takes effect on the next scan. An unknown code, or the database
 * being unreachable, still lands somewhere useful rather than on an error.
 */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  let links = parseQrLinks(null);
  try {
    const { data } = await db().from("platform_settings").select("value_json").eq("key", QR_LINKS_KEY).maybeSingle();
    links = parseQrLinks((data as { value_json: unknown } | null)?.value_json);
  } catch {
    // Fall back to the built-in targets.
  }
  const target = links[code.toLowerCase()]?.target ?? "/";
  const res = NextResponse.redirect(new URL(target, request.url), 307);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
