import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { db } from "@/lib/supabase";
import { leagueSessionTournamentIds } from "@/lib/leagues/server";

/**
 * What a referee can score: active and draft tournaments, newest first, and the
 * nights and season fixtures of the organisation's leagues (a league session's
 * hidden tournament; every other friendly session stays out of the app).
 */
export async function GET() {
  const gate = await staffRoute("score_match");
  if (!gate.ok) return gate.response;
  const { staff } = gate;
  const role = staff.role;
  // This organisation's only, and only the one tournament an event code is scoped to.
  let q = db()
    .from("tournaments")
    .select("id, name, slug, sport, kind, status, is_demo, starts_on, ends_on")
    .eq("organization_id", staff.orgId)
    .in("kind", ["tournament", "friendly_session"]);
  if (staff.scopeTournamentId) q = q.eq("id", staff.scopeTournamentId);
  // A chair umpire code (migration 0034): only the events that have its court.
  if (staff.scopeCourt) q = q.in("id", staff.scopeCourt.withCourt.length ? staff.scopeCourt.withCourt : ["00000000-0000-4000-8000-000000000000"]);
  // A master referee (migration 0035): its events' tournaments, every court.
  if (staff.scopeTournamentIds) q = q.in("id", staff.scopeTournamentIds.length ? staff.scopeTournamentIds : ["00000000-0000-4000-8000-000000000000"]);
  const { data } = await q
    .in("status", ["active", "draft"])
    .order("created_at", { ascending: false })
    .limit(80);
  const rows = (data ?? []) as { id: string; kind: string }[];
  const leagueSessions = rows.some((r) => r.kind === "friendly_session") ? await leagueSessionTournamentIds() : new Set<string>();
  const tournaments = rows
    .filter((r) => r.kind === "tournament" || leagueSessions.has(r.id))
    .slice(0, 40)
    .map((r) => {
      const { kind, ...rest } = r;
      void kind;
      return rest;
    });
  // `court` is new (null for every other credential); 1.0.1 ignores it.
  const court = staff.scopeCourt ? { name: staff.scopeCourt.name } : null;
  // New (migration 0035): the referee signed in with their PIN, and whether they are a master referee; 1.0.1 ignores both.
  const referee = staff.referee ? { name: staff.referee.name, role: staff.referee.role } : null;
  return NextResponse.json({ role, organization: { name: staff.orgName, slug: staff.orgSlug }, court, referee, tournaments }, { headers: { "Cache-Control": "private, no-store" } });
}
