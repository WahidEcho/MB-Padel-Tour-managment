import { NextResponse } from "next/server";
import { getCourtsLive } from "@/lib/mobile/courts";
import { publicJson } from "@/lib/mobile/http";

/**
 * The live courts hero on Discover: every court of the featured event and of each
 * live tournament, in the Discover order. Polled every few seconds while Discover
 * is on screen; the CDN shares one copy, like the live feed. `?demo=1` includes
 * demo events, as Discover does; nothing else is read from the request.
 */
export async function GET(request: Request) {
  const demo = new URL(request.url).searchParams.get("demo");
  if (demo !== null && demo !== "0" && demo !== "1") {
    return NextResponse.json({ error: "demo must be 0 or 1" }, { status: 400, headers: { "Cache-Control": "public, max-age=0, s-maxage=60" } });
  }
  return publicJson(await getCourtsLive(demo === "1"), 2, 10);
}
