import { NextResponse } from "next/server";
import { can, currentRole } from "@/lib/auth";
import { db } from "@/lib/supabase";
import { getCourts, getMatches, getTeams } from "@/lib/data";
import { getLiveLeasesByMatch } from "@/lib/scoringControl";
import { isViewersDevice, presentedDeviceId, shownDeviceId, verifyInstallToken } from "@/lib/mobile/identity";

/**
 * The referee's match picker: every match with its court, time, sides and who
 * holds it. A holder's device id is this phone's own id (sent with its install
 * token) or a handle, never another phone's installation id.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const role = await currentRole();
  if (!can(role, "score_match")) return NextResponse.json({ error: "Sign in with the referee code" }, { status: 403 });
  const viewer = { installationId: verifyInstallToken(request.headers.get("x-install-token")), deviceId: presentedDeviceId(request.headers), staff: true };
  const { id } = await params;
  const [{ data: t }, matches, teams, courts, leases] = await Promise.all([
    db().from("tournaments").select("id, name, sport, timezone").eq("id", id).maybeSingle(),
    getMatches(id),
    getTeams(id),
    getCourts(id),
    getLiveLeasesByMatch(id),
  ]);
  if (!t) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
  const team = new Map(teams.map((x) => [x.id, x]));
  const court = new Map(courts.map((c) => [c.id, c.court_name]));
  const label = (teamId: string | null, nominees: string[] | null | undefined, isRubber: boolean) => {
    if (!teamId) return { name: "TBD", code: null, iso2: null, checkedIn: false };
    const x = team.get(teamId);
    const players = isRubber && nominees?.length ? (x?.players ?? []).filter((p) => nominees.includes(p.id)) : [];
    const name = isRubber && players.length ? players.map((p) => p.full_name).join(" / ") : (x?.team_name ?? "?");
    return { name, code: x?.nation_code ?? null, iso2: x?.iso2 ?? null, checkedIn: x?.check_in_status === "checked_in" };
  };
  return NextResponse.json(
    {
      tournament: t,
      matches: matches
        .filter((m) => m.status !== "cancelled")
        .map((m) => {
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
          };
        }),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
