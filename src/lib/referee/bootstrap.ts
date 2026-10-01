/**
 * Everything a scoring phone needs to take a match: the resolved rules, the two
 * sides as the referee sees them, the score, and the undo history.
 *
 * The same resolution as the web console's page loader
 * (src/app/referee/matches/[matchId]/score/page.tsx), so both consoles score a
 * match under identical rules.
 */
import { db } from "../supabase";
import { getCourts, getMatch, getReopenState, getSnapshot, getTeams, getTournament, tierForMatch } from "../data";
import { isDoublesMatch, scoringConfigForMatch } from "../scoring/rules";
import { redBlueTeams } from "../sides";
import { getLease, isLeaseLive } from "../scoringControl";
import type { Match, MatchSnapshot, ScoringConfig, Team } from "../types";

export interface RefereeSide {
  id: string;
  name: string;
  nation: string | null;
  iso2: string | null;
  checkedIn: boolean;
  players: { id: string; name: string }[];
}

export interface RefereeBootstrap {
  match: Match;
  tournament: { id: string; name: string; sport: string; timezone: string };
  courtName: string;
  config: ScoringConfig;
  tennis: boolean;
  chess: boolean;
  /** Line-ups not yet nominated: the rubber cannot start. */
  waitingForLineups: string | null;
  sideA: RefereeSide | null;
  sideB: RefereeSide | null;
  snapshot: MatchSnapshot | null;
  reopenState: Record<string, unknown> | null;
  /** States to undo back through, oldest first (the web console keeps the same stack). */
  history: unknown[];
  redBlueTeams: boolean;
  lease: { deviceId: string; deviceLabel: string | null; expiresAt: string; isLive: boolean } | null;
}

const HISTORY_EVENTS = 300;

export async function refereeBootstrap(matchId: string): Promise<RefereeBootstrap | null> {
  const match = await getMatch(matchId);
  if (!match || !match.team_a_id || !match.team_b_id) return null;
  const [tournament, teams, courts, snapshot, tier, lease, events] = await Promise.all([
    getTournament(match.tournament_id),
    getTeams(match.tournament_id),
    getCourts(match.tournament_id),
    getSnapshot(matchId),
    tierForMatch(match),
    getLease(matchId),
    db()
      .from("score_events")
      .select("event_number, event_type, previous_state_json")
      .eq("match_id", matchId)
      .order("event_number", { ascending: false })
      .limit(HISTORY_EVENTS),
  ]);
  if (!tournament) return null;
  const reopenState = match.status === "completed" ? await getReopenState(matchId) : null;
  const nationA = teams.find((t) => t.id === match.team_a_id)!;
  const nationB = teams.find((t) => t.id === match.team_b_id)!;
  const nominees = (team: Team, ids: string[] | null | undefined) =>
    ids?.length ? { ...team, players: ids.map((id) => team.players?.find((p) => p.id === id)).filter((p) => p !== undefined) } : null;
  const teamA = match.tie_id ? nominees(nationA, match.team_a_player_ids) : nationA;
  const teamB = match.tie_id ? nominees(nationB, match.team_b_player_ids) : nationB;
  const sideName = (t: Team) =>
    match.tie_id
      ? `${(t.players ?? []).map((p) => p.full_name.split(" ").slice(-1)[0]).join(" / ")} (${t.nation_code ?? t.team_name})`
      : t.team_name;
  const side = (t: Team | null): RefereeSide | null =>
    t
      ? {
          id: t.id,
          name: sideName(t),
          nation: match.tie_id ? (t.nation_code ?? null) : null,
          iso2: t.iso2 ?? null,
          checkedIn: t.check_in_status === "checked_in",
          players: (t.players ?? []).map((p) => ({ id: p.id, name: p.full_name })),
        }
      : null;
  // Rebuild the undo stack the way the web console builds it: every event pushes
  // the state before it, an UNDO pops one.
  const rows = ((events.data ?? []) as { event_number: number; event_type: string; previous_state_json: unknown }[]).reverse();
  const history: unknown[] = [];
  for (const r of rows) {
    if (r.event_type === "UNDO") history.pop();
    else if (r.previous_state_json) history.push(r.previous_state_json);
  }
  const court = courts.find((c) => c.id === match.court_id);
  return {
    match,
    tournament: { id: tournament.id, name: tournament.name, sport: tournament.sport, timezone: tournament.timezone || "Africa/Cairo" },
    courtName: court?.court_name ?? "No court",
    config: scoringConfigForMatch(tournament, match, tier, {
      doubles: match.rubber_type ? match.rubber_type === "D" : isDoublesMatch(teamA ?? undefined, teamB ?? undefined),
    }),
    tennis: tournament.sport === "tennis",
    chess: tournament.sport === "chess",
    waitingForLineups: !teamA ? nationA.team_name : !teamB ? nationB.team_name : null,
    sideA: side(teamA),
    sideB: side(teamB),
    snapshot,
    reopenState,
    history: history.slice(-200),
    redBlueTeams: redBlueTeams(tournament.branding_config),
    lease: lease
      ? { deviceId: lease.device_id, deviceLabel: lease.device_label, expiresAt: lease.expires_at, isLive: isLeaseLive(lease, Date.now()) }
      : null,
  };
}
