import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { db } from "@/lib/supabase";
import { getCourts, getMatches, getTeams } from "@/lib/data";
import { earlierForCourt, filterForCourt, scoresOf } from "@/lib/referee/courtList";
import { getLiveLeasesByMatch } from "@/lib/scoringControl";
import { isViewersDevice, presentedDeviceId, shownDeviceId, verifyInstallToken } from "@/lib/mobile/identity";

/**
 * The referee's match picker: every match with its court, time, sides and who
 * holds it. A holder's device id is this phone's own id (sent with its install
 * token) or a handle, never another phone's installation id.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Organisation and an event code's scope, from the tournament itself.
  const gate = await staffRoute("score_match", { tournament: id });
  if (!gate.ok) return gate.response;
  const viewer = { installationId: verifyInstallToken(request.headers.get("x-install-token")), deviceId: presentedDeviceId(request.headers), staff: true };
  const [{ data: t }, all, teams, courts, leases] = await Promise.all([
    db().from("tournaments").select("id, name, sport, timezone").eq("id", id).maybeSingle(),
    getMatches(id),
    getTeams(id),
    getCourts(id),
    getLiveLeasesByMatch(id),
  ]);
  if (!t) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
  // A court referee code (migration 0034): today's matches on its court only (live, upcoming, finished today);
  // with ?earlier=1 ("Show earlier days") also the court's matches of past days. Both with their scores.
  const courtScope = gate.staff.scopeCourt;
  const tz = (t as { timezone: string | null }).timezone || "Africa/Cairo";
  const matches = courtScope ? filterForCourt(courtScope, all, tz) : all;
  const earlier = courtScope && new URL(request.url).searchParams.get("earlier") === "1" ? earlierForCourt(courtScope, all, tz) : null;
  const scores = courtScope ? await scoresOf([...matches, ...(earlier ?? []).flatMap((d) => d.matches)].map((m) => m.id)) : new Map<string, string>();
  const team = new Map(teams.map((x) => [x.id, x]));
  const court = new Map(courts.map((c) => [c.id, c.court_name]));
  const label = (teamId: string | null, nominees: string[] | null | undefined, isRubber: boolean) => {
    if (!teamId) return { name: "TBD", code: null, iso2: null, checkedIn: false };
    const x = team.get(teamId);
    const players = isRubber && nominees?.length ? (x?.players ?? []).filter((p) => nominees.includes(p.id)) : [];
    const name = isRubber && players.length ? players.map((p) => p.full_name).join(" / ") : (x?.team_name ?? "?");
    return { name, code: x?.nation_code ?? null, iso2: x?.iso2 ?? null, checkedIn: x?.check_in_status === "checked_in" };
  };
  const row = (m: (typeof all)[number]) => {
    const lease = leases.get(m.id);
    return {
      id: m.id,
      order: m.match_order,
      round: m.round_name,
      court: m.court_id ? (court.get(m.court_id) ?? null) : null,
      scheduledTime: m.scheduled_time,
      status: m.status,
      tieId: m.tie_id ?? null,
      rubberType: m.rubber_type ?? null,
      a: label(m.team_a_id, m.team_a_player_ids, Boolean(m.tie_id)),
      b: label(m.team_b_id, m.team_b_player_ids, Boolean(m.tie_id)),
      lineupsMissing: Boolean(m.tie_id) && !(m.team_a_player_ids?.length && m.team_b_player_ids?.length),
      heldBy: lease
        ? {
            deviceId: shownDeviceId(lease.device_id, viewer),
            deviceLabel: lease.device_label,
            heldByYou: isViewersDevice(lease.device_id, viewer),
          }
        : null,
      // New: the sets so far (court codes only); 1.0.1 ignores it.
      ...(courtScope ? { score: scores.get(m.id) ?? null } : {}),
    };
  };
  return NextResponse.json(
    {
      tournament: t,
      // New (null for every other credential); 1.0.1 ignores it.
      court: courtScope ? { name: courtScope.name } : null,
      matches: matches.filter((m) => m.status !== "cancelled").map(row),
      ...(earlier ? { earlier: earlier.map((d) => ({ day: d.day, matches: d.matches.map(row) })) } : {}),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
