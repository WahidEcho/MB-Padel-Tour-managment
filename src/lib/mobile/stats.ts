/**
 * Match and tie stats for fans (pure computation in scoring/stats.ts). Server-only.
 *
 * Visible exactly where the match detail is: the tournament is public and of kind
 * "tournament" (getMatchDetail's rule). Reads explicit columns only, and of each
 * stored state only the few fields stats need (who served, the point score, the set),
 * never the whole ~2 KB state per point, and never who entered an event: no referee
 * names, no private fields. Aces only when the organiser shows them (Admin → Scoring
 * features: "Show aces on TV & app").
 */
import { db } from "../supabase";
import type { Match, ScoringConfig, Tie } from "../types";
import type { ScoreState } from "../scoring/engine";
import { scoringConfigForMatch } from "../scoring/rules";
import { sportOf } from "../sports/registry";
import { computeMatchStats, statsUnavailable, swapSides, tieStats, type MatchStatsResult, type StatsEventRow, type TieRubberStats } from "../scoring/stats";
import { memo } from "./http";
import { scoreExtrasOf } from "./projection";
import type { MMatchStats, MTieStats } from "./contract";

const STATS_MATCH_COLUMNS =
  "id, tournament_id, stage, bracket_id, tie_id, rubber_no, rubber_type, team_a_id, team_b_id, team_a_player_ids, status, result_source";

/** Of each event: the type, side, payload and time, and the parts of the state before it that stats read. */
const EVENT_COLUMNS = [
  "match_id",
  "event_number",
  "event_type",
  "team_id",
  "note",
  "created_at_client",
  "created_at_server",
  "sync_status",
  "pa:previous_state_json->teamA",
  "pb:previous_state_json->teamB",
  "ptb:previous_state_json->isTiebreak",
  "pmtb:previous_state_json->isMatchTiebreak",
  "psrv:previous_state_json->servingTeam",
  "ptbf:previous_state_json->tiebreakFirstServer",
  "pset:previous_state_json->currentSet",
].join(", ");

interface TournamentRow {
  id: string;
  kind: string;
  sport: string;
  public_access_enabled: boolean;
  scoring_config: ScoringConfig | null;
  match_day_rules: unknown;
}

type StatsMatch = Pick<Match, "id" | "tournament_id" | "stage" | "bracket_id" | "tie_id" | "rubber_no" | "rubber_type" | "team_a_id" | "team_b_id" | "team_a_player_ids" | "status" | "result_source">;

async function publicTournament(id: string): Promise<TournamentRow | null> {
  const { data } = await db().from("tournaments").select("id, kind, sport, public_access_enabled, scoring_config, match_day_rules").eq("id", id).maybeSingle();
  const t = data as TournamentRow | null;
  return t && t.public_access_enabled && t.kind === "tournament" ? t : null;
}

function parseNote(note: string | null): Record<string, unknown> | null {
  if (!note) return null;
  try {
    const v = JSON.parse(note) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toRow(r: Record<string, unknown>): StatsEventRow & { match_id: string } {
  const prev = r.pa && r.pb
    ? { teamA: r.pa, teamB: r.pb, isTiebreak: r.ptb === true, isMatchTiebreak: r.pmtb === true, servingTeam: r.psrv ?? null, tiebreakFirstServer: r.ptbf ?? null, currentSet: r.pset ?? 1 }
    : null;
  return {
    match_id: String(r.match_id),
    event_number: Number(r.event_number),
    event_type: String(r.event_type),
    team_id: (r.team_id as string | null) ?? null,
    payload: parseNote((r.note as string | null) ?? null),
    prev,
    at: ((r.created_at_client as string | null) ?? (r.created_at_server as string | null)) ?? null,
    superseded: r.sync_status === "superseded",
  };
}

/** Stats for each of these matches (one tournament), from their events and snapshots. */
async function statsFor(matches: StatsMatch[], t: TournamentRow): Promise<Map<string, MatchStatsResult>> {
  const out = new Map<string, MatchStatsResult>();
  if (!matches.length) return out;
  if (sportOf(t).engine !== "games") {
    for (const m of matches) out.set(m.id, statsUnavailable("unsupported"));
    return out;
  }
  const ids = matches.map((m) => m.id);
  const bracketIds = [...new Set(matches.map((m) => m.bracket_id).filter((v): v is string => Boolean(v)))];
  const [events, snaps, brackets] = await Promise.all([
    db().from("score_events").select(EVENT_COLUMNS).in("match_id", ids).order("event_number").limit(20000),
    db().from("match_score_snapshots").select("match_id, snapshot_json").in("match_id", ids),
    bracketIds.length ? db().from("brackets").select("id, tier").in("id", bracketIds) : Promise.resolve({ data: [] }),
  ]);
  const rowsOf = new Map<string, StatsEventRow[]>();
  for (const raw of (events.data ?? []) as unknown as Record<string, unknown>[]) {
    const r = toRow(raw);
    rowsOf.set(r.match_id, [...(rowsOf.get(r.match_id) ?? []), r]);
  }
  const stateOf = new Map(((snaps.data ?? []) as { match_id: string; snapshot_json: unknown }[]).map((s) => [s.match_id, s.snapshot_json as ScoreState | null]));
  const tierOf = new Map(((brackets.data ?? []) as { id: string; tier: "cup" | "plate" }[]).map((b) => [b.id, b.tier]));
  const showAces = scoreExtrasOf(t)?.aces ?? false;
  for (const m of matches) {
    const config = scoringConfigForMatch(t, m, m.bracket_id ? (tierOf.get(m.bracket_id) ?? null) : null, {
      doubles: m.rubber_type ? m.rubber_type === "D" : (m.team_a_player_ids?.length ?? 0) > 1,
    });
    const final = stateOf.get(m.id);
    out.set(
      m.id,
      computeMatchStats(rowsOf.get(m.id) ?? [], {
        teamA: m.team_a_id,
        teamB: m.team_b_id,
        config,
        final: final && typeof final === "object" && "teamA" in final ? final : null,
        showAces,
        resultSource: m.result_source ?? null,
      }),
    );
  }
  return out;
}

/** One match's stats, only if its tournament is public. */
export function getMatchStats(matchId: string): Promise<MMatchStats | null> {
  return memo(`stats:match:${matchId}`, 2_000, async () => {
    const { data } = await db().from("matches").select(STATS_MATCH_COLUMNS).eq("id", matchId).maybeSingle();
    const m = data as unknown as StatsMatch | null;
    if (!m) return null;
    const t = await publicTournament(m.tournament_id);
    if (!t) return null;
    const stats = (await statsFor([m], t)).get(m.id)!;
    return { matchId: m.id, a: m.team_a_id, b: m.team_b_id, status: m.status, stats };
  });
}

/** A tie's stats: its rubbers' summed per nation (rubbers listing the teams the other way round are turned). */
export function getTieStats(tieId: string): Promise<MTieStats | null> {
  return memo(`stats:tie:${tieId}`, 3_000, async () => {
    const { data } = await db().from("ties").select("id, tournament_id, team_a_id, team_b_id, status").eq("id", tieId).maybeSingle();
    const tie = data as Pick<Tie, "id" | "tournament_id" | "team_a_id" | "team_b_id" | "status"> | null;
    if (!tie) return null;
    const t = await publicTournament(tie.tournament_id);
    if (!t) return null;
    const { data: rubbers } = await db().from("matches").select(STATS_MATCH_COLUMNS).eq("tie_id", tieId).order("rubber_no");
    const ms = ((rubbers ?? []) as unknown as StatsMatch[]).filter((m) => m.status !== "cancelled");
    const byId = await statsFor(ms, t);
    const list: TieRubberStats[] = ms.map((m) => {
      const s = byId.get(m.id)!;
      const turned = Boolean(tie.team_a_id && m.team_b_id === tie.team_a_id);
      return { matchId: m.id, rubberNo: m.rubber_no ?? null, rubberType: m.rubber_type ?? null, stats: turned ? swapSides(s) : s };
    });
    return { tieId: tie.id, a: tie.team_a_id, b: tie.team_b_id, status: tie.status, stats: tieStats(list, scoreExtrasOf(t)?.aces ?? false) };
  });
}

/** CDN seconds: a few while play is on, longer once it is over. */
export function statsCacheSeconds(status: string): [number, number] {
  return ["live", "paused", "pending_sync", "ready", "scheduled"].includes(status) ? [3, 10] : [60, 300];
}
