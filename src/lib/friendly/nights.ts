/**
 * Americano / Mexicano nights on the server (plan Phase 8): the organiser's
 * "Confirm players and publish table" step, the re-estimate of the table as
 * matches start and finish, linking the night's player rows to the players' app
 * accounts, and the table every surface draws.
 *
 *   publishNightTable       confirm who plays → generate → link → alert the players
 *   reestimateSessionTable  replan the waiting matches' "about" times from what happened
 *                           (results/hooks.ts on finish and undo, append.ts on start)
 *   nightTableFor           the table (src/lib/friendly/nightTable.ts) with public names
 *
 * Alerts go to the players only, through their own accounts (player_claims),
 * filtered by each phone's "scheduled" switch, and only for nights the app shows
 * (a public league's nights): a stand-alone session's table is published on its
 * web page, not pushed. PUSH_DRY_RUN=1 keeps everything on the server.
 *
 * Server-only.
 */
import { db } from "../supabase";
import { audit } from "../audit";
import { getCourts } from "../data";
import { matchDayRules } from "../matchday/rules";
import type { FormatConfig } from "../types";
import { buildNightTable, isNightMatchDone, reestimateNight, type NightTable, type NightTableMatch } from "./nightTable";
import { generateSchedule } from "./ops";

const WAITING = ["scheduled", "ready"];

interface SessionRow {
  id: string;
  tournament_id: string;
  name: string;
  status: string;
  starts_at: string | null;
  expected_match_minutes: number | null;
  turnover_minutes: number | null;
  pairing_mode: string;
}

const SESSION_COLUMNS = "id, tournament_id, name, status, starts_at, expected_match_minutes, turnover_minutes, pairing_mode";

async function sessionOfTournament(tournamentId: string): Promise<SessionRow | null> {
  const { data } = await db().from("friendly_sessions").select(SESSION_COLUMNS).eq("tournament_id", tournamentId).maybeSingle();
  return data as SessionRow | null;
}

interface MatchRow {
  id: string;
  court_id: string | null;
  match_order: number;
  round_name: string | null;
  status: string;
  scheduled_time: string | null;
  started_at: string | null;
  ended_at: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  winner_team_id: string | null;
}

const MATCH_COLUMNS = "id, court_id, match_order, round_name, status, scheduled_time, started_at, ended_at, team_a_id, team_b_id, winner_team_id";

async function friendlyMatches(tournamentId: string): Promise<MatchRow[]> {
  const { data } = await db().from("matches").select(MATCH_COLUMNS).eq("tournament_id", tournamentId).eq("stage", "friendly").order("match_order").limit(2000);
  return (data ?? []) as MatchRow[];
}

/* ---------------- re-estimating ---------------- */

/**
 * Replans the "about" times of a session's waiting matches from what has
 * happened (src/lib/friendly/nightTable.ts reestimateNight) and stores the ones
 * that moved. A no-op for anything that is not a session with a start time.
 * Returns how many matches moved.
 */
export async function reestimateSessionTable(tournamentId: string, now = Date.now()): Promise<number> {
  const session = await sessionOfTournament(tournamentId);
  if (!session?.starts_at) return 0;
  const matches = await friendlyMatches(tournamentId);
  if (!matches.some((m) => WAITING.includes(m.status))) return 0;
  const { data: parts } = await db()
    .from("friendly_match_participants")
    .select("match_id, team_a_player_one, team_a_player_two, team_b_player_one, team_b_player_two")
    .eq("session_id", session.id);
  const playersOf = new Map(
    ((parts ?? []) as { match_id: string; team_a_player_one: string | null; team_a_player_two: string | null; team_b_player_one: string | null; team_b_player_two: string | null }[]).map((p) => [
      p.match_id,
      [p.team_a_player_one, p.team_a_player_two, p.team_b_player_one, p.team_b_player_two].filter(Boolean) as string[],
    ]),
  );
  // The rotation table only: matches whose four players are known (a group stage or a
  // knockout drawn on a session has no participants until played, and no estimates).
  const next = reestimateNight(
    matches
      .filter((m) => playersOf.has(m.id))
      .map((m) => ({ id: m.id, courtId: m.court_id, order: m.match_order, status: m.status, startedAt: m.started_at, endedAt: m.ended_at, players: playersOf.get(m.id)! })),
    { start: session.starts_at, matchMinutes: session.expected_match_minutes ?? 30, changeoverMinutes: session.turnover_minutes ?? 5, now },
  );
  let moved = 0;
  for (const m of matches) {
    const at = next.get(m.id);
    if (!at || (m.scheduled_time && Date.parse(m.scheduled_time) === Date.parse(at))) continue;
    // Only while it is still waiting: a match that started meanwhile keeps its time.
    await db().from("matches").update({ scheduled_time: at }).eq("id", m.id).in("status", WAITING);
    moved++;
  }
  return moved;
}

/* ---------------- the players' own accounts ---------------- */

/**
 * The night's player rows are new rows (one per pairing): each goes to its
 * player's own account by the one linking rule (src/lib/players/link.ts
 * linkProfileRowsIn): the profile's own account (player_profiles.auth_user_id),
 * when the organisation vouches for the profile or the account itself joined this
 * league (an active membership made by that same account). Never an account found
 * only through league_members.auth_user_id or another row's claim. Derived claims
 * hang on the code that gave the account its profile, so resetting it undoes them.
 * Returns how many rows were linked.
 */
export async function linkNightPlayers(tournamentId: string, leagueId: string | null): Promise<number> {
  const { linkProfileRowsIn } = await import("../players/link");
  return linkProfileRowsIn(tournamentId, { leagueId });
}

/* ---------------- which league a night belongs to ---------------- */

/** The public league (of an approved organisation) a session is a night of, or null (a stand-alone session, or a league that is not public). */
export async function publicLeagueOfSession(sessionId: string): Promise<{ id: string; slug: string } | null> {
  const { data: f } = await db().from("league_fixtures").select("league_id").eq("session_id", sessionId).eq("kind", "night").limit(1);
  const leagueId = ((f ?? []) as { league_id: string }[])[0]?.league_id;
  if (!leagueId) return null;
  const { data: l } = await db().from("leagues").select("id, slug, status, organization_id").eq("id", leagueId).maybeSingle();
  const league = l as { id: string; slug: string; status: string; organization_id: string } | null;
  if (!league || !["active", "closed"].includes(league.status)) return null;
  // A suspended or pending organisation's leagues are not public: no alerts, no links.
  const { data: o } = await db().from("organizations").select("status").eq("id", league.organization_id).maybeSingle();
  return (o as { status: string } | null)?.status === "approved" ? { id: league.id, slug: league.slug } : null;
}

/* ---------------- publishing ---------------- */

export interface PublishInput {
  /** The players confirmed for tonight (profile ids). Approved entries left out are withdrawn. Null keeps everyone approved. */
  playing: string[] | null;
  /** Minutes a match takes and the changeover between matches on a court (the estimates' inputs). */
  matchMinutes?: number | null;
  changeoverMinutes?: number | null;
}

export interface PublishOutcome {
  matches: number;
  rounds: number;
  players: number;
  withdrawn: number;
  linked: number;
  alerts: number;
  warnings: string[];
}

const clampInt = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : null;
};

/**
 * "Confirm players and publish table": the organiser confirms who is playing,
 * the table is (re)generated with its order of play per court and "about"
 * times, the players' accounts are linked to their rows for the night, and each
 * player hears their court and time. Only before the night has started: once a
 * match is under way the table changes through results (and Mexicano's next
 * round), not by publishing again.
 */
export async function publishNightTable(sessionId: string, input: PublishInput, actor: { role: string; userId?: string | null }): Promise<PublishOutcome> {
  const { data: s } = await db().from("friendly_sessions").select(SESSION_COLUMNS).eq("id", sessionId).maybeSingle();
  const session = s as SessionRow | null;
  if (!session) throw new Error("Session not found");
  if (session.status === "finalized") throw new Error("This night is finalized. Reopen it before changing its table.");
  const before = await friendlyMatches(session.tournament_id);
  if (before.some((m) => !WAITING.includes(m.status))) {
    throw new Error("The night has started: its table is out. Results (and Mexicano's next round) change it from here.");
  }

  // 1. Who plays tonight.
  const { data: entries } = await db().from("friendly_entries").select("id, player_profile_id, approval").eq("session_id", sessionId);
  const approved = ((entries ?? []) as { id: string; player_profile_id: string; approval: string }[]).filter((e) => e.approval === "approved");
  let withdrawn = 0;
  if (input.playing) {
    const confirmed = new Set(input.playing);
    const strangers = [...confirmed].filter((id) => !approved.some((e) => e.player_profile_id === id));
    if (strangers.length) throw new Error("Only players entered for this night can be confirmed.");
    const out = approved.filter((e) => !confirmed.has(e.player_profile_id));
    if (approved.length - out.length < 4) throw new Error("Confirm at least 4 players to build the table.");
    if (out.length) {
      const at = new Date().toISOString();
      await db().from("friendly_entries").update({ approval: "withdrawn", updated_at: at }).in("id", out.map((e) => e.id));
      withdrawn = out.length;
    }
  } else if (approved.length < 4) {
    throw new Error("At least 4 approved players are needed to build the table.");
  }

  // 2. How long a match takes, for the estimates.
  const minutes = clampInt(input.matchMinutes, 5, 240);
  const changeover = clampInt(input.changeoverMinutes, 0, 60);
  if (minutes !== null || changeover !== null) {
    await db()
      .from("friendly_sessions")
      .update({
        ...(minutes !== null ? { expected_match_minutes: minutes } : {}),
        ...(changeover !== null ? { turnover_minutes: changeover } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);
  }

  // 3. The table: generated (or regenerated, nothing has started), estimated from the night's start.
  const result = await generateSchedule(sessionId, actor.role);

  // 4. Published: the surfaces say so and the app may alert.
  const { data: t } = await db().from("tournaments").select("format_config, match_day_rules, sport").eq("id", session.tournament_id).maybeSingle();
  const tr = t as { format_config: FormatConfig | null; match_day_rules: unknown; sport: string | null } | null;
  const publishedAt = new Date().toISOString();
  await db()
    .from("tournaments")
    .update({ format_config: { ...(tr?.format_config ?? {}), nightTable: { publishedAt, publishedBy: actor.role } } })
    .eq("id", session.tournament_id);

  // 5. The players' accounts and their alerts (a public league's nights only: the app shows those).
  const league = await publicLeagueOfSession(sessionId);
  let linked = 0;
  let alerts = 0;
  if (league) {
    linked = await linkNightPlayers(session.tournament_id, league.id);
    const rules = matchDayRules(tr?.match_day_rules, tr?.sport ?? null);
    if (rules.alerts.on) alerts = await alertNightPlayers(session.tournament_id);
  }

  await audit({
    tournament_id: session.tournament_id,
    actor_role: actor.role,
    action: "NIGHT_TABLE_PUBLISHED",
    entity_type: "friendly_session",
    entity_id: sessionId,
    new_value: {
      matches: result.matchesCreated,
      rounds: result.roundsCreated,
      players: approved.length - withdrawn,
      withdrawn,
      linked,
      alerts,
      match_minutes: minutes,
      changeover_minutes: changeover,
    },
  });

  return { matches: result.matchesCreated, rounds: result.roundsCreated, players: approved.length - withdrawn, withdrawn, linked, alerts, warnings: result.warnings };
}

/**
 * After a published night gains matches (Mexicano's next round): link the new
 * rows and tell their players. Nothing for an unpublished table or a stand-alone session.
 */
export async function afterNightRoundAdded(sessionId: string): Promise<number> {
  const { data: s } = await db().from("friendly_sessions").select("tournament_id").eq("id", sessionId).maybeSingle();
  if (!s) return 0;
  const tournamentId = (s as { tournament_id: string }).tournament_id;
  const { data: t } = await db().from("tournaments").select("format_config, match_day_rules, sport").eq("id", tournamentId).maybeSingle();
  const tr = t as { format_config: FormatConfig | null; match_day_rules: unknown; sport: string | null } | null;
  if (!tr?.format_config?.nightTable?.publishedAt) return 0;
  const league = await publicLeagueOfSession(sessionId);
  if (!league) return 0;
  await linkNightPlayers(tournamentId, league.id);
  return matchDayRules(tr.match_day_rules, tr.sport ?? null).alerts.on ? alertNightPlayers(tournamentId) : 0;
}

/** One "your court and time" alert per waiting match, to that match's players. Returns how many were queued. */
async function alertNightPlayers(tournamentId: string): Promise<number> {
  const matches = (await friendlyMatches(tournamentId)).filter((m) => WAITING.includes(m.status) && m.team_a_id && m.team_b_id);
  if (!matches.length) return 0;
  const { notifyMatchScheduled } = await import("../notify/hooks");
  const position = positionsOnCourt(await friendlyMatches(tournamentId));
  for (const m of matches) await notifyMatchScheduled(m.id, { night: { position: position.get(m.id) ?? null } });
  return matches.length;
}

/** Each match's 1-based place in its court's order of play. */
function positionsOnCourt(matches: MatchRow[]): Map<string, number> {
  const seen = new Map<string, number>();
  const out = new Map<string, number>();
  for (const m of [...matches].sort((a, b) => a.match_order - b.match_order)) {
    if (!m.court_id) continue;
    const n = (seen.get(m.court_id) ?? 0) + 1;
    seen.set(m.court_id, n);
    out.set(m.id, n);
  }
  return out;
}

/* ---------------- the table, for every surface ---------------- */

export interface NightTableView {
  table: NightTable;
  publishedAt: string | null;
  /** Some match has an estimated time (a rotation table with a start time). */
  estimated: boolean;
  timeZone: string;
}

/**
 * A session's table with public side names (team names, never contact fields),
 * or null when it has no rotation matches yet.
 */
export async function nightTableFor(tournamentId: string): Promise<NightTableView | null> {
  const [matches, courts, teamsRes, tRes] = await Promise.all([
    friendlyMatches(tournamentId),
    getCourts(tournamentId),
    db().from("teams").select("id, team_name").eq("tournament_id", tournamentId),
    db().from("tournaments").select("timezone, format_config").eq("id", tournamentId).maybeSingle(),
  ]);
  if (!matches.length) return null;
  const names = new Map(((teamsRes.data ?? []) as { id: string; team_name: string }[]).map((t) => [t.id, t.team_name]));
  const tr = tRes.data as { timezone: string | null; format_config: FormatConfig | null } | null;
  const timeZone = tr?.timezone || "Africa/Cairo";
  const rows: NightTableMatch[] = matches.map((m) => ({
    id: m.id,
    courtId: m.court_id,
    order: m.match_order,
    round: m.round_name,
    status: m.status,
    scheduledTime: m.scheduled_time,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    a: m.team_a_id ? (names.get(m.team_a_id) ?? null) : null,
    b: m.team_b_id ? (names.get(m.team_b_id) ?? null) : null,
    winner: isNightMatchDone(m.status) && m.winner_team_id ? (m.winner_team_id === m.team_a_id ? "A" : m.winner_team_id === m.team_b_id ? "B" : null) : null,
  }));
  return {
    table: buildNightTable(courts.map((c) => ({ id: c.id, name: c.court_name, order: c.court_order })), rows, { timeZone }),
    publishedAt: tr?.format_config?.nightTable?.publishedAt ?? null,
    estimated: matches.some((m) => m.scheduled_time !== null),
    timeZone,
  };
}
