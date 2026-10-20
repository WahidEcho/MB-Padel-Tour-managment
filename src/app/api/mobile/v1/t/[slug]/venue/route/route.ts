import { NextResponse } from "next/server";
import { notFoundJson, privateJson, readJson } from "@/lib/mobile/http";
import { publicVenueBySlug } from "@/lib/venue/server";
import { planRoute, routeStart, targetOf } from "@/lib/venue/route";
import { formatDistance, formatDuration } from "@/lib/venue/directions";

/**
 * POST /api/mobile/v1/t/<slug>/venue/route { to: "court:<id|number>" | "poi:<id>", from?: { lat, lng, accuracy } }
 * → the walking route along the venue's walkways, with its steps. The map
 * itself plans routes on the phone (offline too); this is the same code for
 * other clients and the E2E gate. A position travels in the body, never in
 * the URL, and the answer is never cached.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const venue = await publicVenueBySlug(slug);
  if (!venue) return notFoundJson("No venue map");
  const body = await readJson<{ to?: unknown; from?: { lat?: unknown; lng?: unknown; accuracy?: unknown } | null }>(request);
  const to = typeof body?.to === "string" ? body.to.slice(0, 80) : "";
  const target = targetOf(venue.doc, to);
  if (!target) return NextResponse.json({ error: "Unknown destination", code: "unknown_target" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  const f = body?.from;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const lat = num(f?.lat);
  const lng = num(f?.lng);
  const fix = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng, accuracy: num(f?.accuracy) } : null;
  const start = routeStart(venue.doc, fix);
  if (!start) return NextResponse.json({ error: "This venue has no entrance to start from", code: "no_start" }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
  const route = planRoute(venue.doc, start, target);
  if (!route) return NextResponse.json({ error: "No walkway leads there", code: "no_route" }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
  return privateJson({
    target: { key: route.target.key, name: route.target.name },
    fromEntrance: route.start.fromEntrance,
    note: route.start.note,
    points: route.points.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })),
    distance: Math.round(route.length),
    seconds: route.seconds,
    summary: `${formatDistance(route.length)} · ${formatDuration(route.seconds)}`,
    steps: route.steps.map((s) => ({ kind: s.kind, text: s.text, distance: Math.round(s.distance), turn: s.turn ?? null })),
  });
}
