import { NextResponse } from "next/server";
import { can, currentRole } from "@/lib/auth";
import { db } from "@/lib/supabase";

/** What a referee can score: active and draft tournaments, newest first. */
export async function GET() {
  const role = await currentRole();
  if (!can(role, "score_match")) return NextResponse.json({ error: "Sign in with the referee code" }, { status: 403 });
  const { data } = await db()
    .from("tournaments")
    .select("id, name, slug, sport, status, is_demo, starts_on, ends_on")
    .eq("kind", "tournament")
    .in("status", ["active", "draft"])
    .order("created_at", { ascending: false })
    .limit(40);
  return NextResponse.json({ role, tournaments: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
}
