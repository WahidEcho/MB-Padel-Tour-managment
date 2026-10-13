import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { db } from "@/lib/supabase";

/** What a referee can score: active and draft tournaments, newest first. */
export async function GET() {
  const gate = await staffRoute("score_match");
  if (!gate.ok) return gate.response;
  const { staff } = gate;
  const role = staff.role;
  // This organisation's only, and only the one tournament an event code is scoped to.
  let q = db()
    .from("tournaments")
    .select("id, name, slug, sport, status, is_demo, starts_on, ends_on")
    .eq("organization_id", staff.orgId)
    .eq("kind", "tournament");
  if (staff.scopeTournamentId) q = q.eq("id", staff.scopeTournamentId);
  const { data } = await q
    .in("status", ["active", "draft"])
    .order("created_at", { ascending: false })
    .limit(40);
  return NextResponse.json({ role, organization: { name: staff.orgName, slug: staff.orgSlug }, tournaments: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
}
