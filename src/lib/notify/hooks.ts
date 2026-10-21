/**
 * Where things happen, the outbox learns about them. Each hook loads the names it
 * needs, composes the alert (compose.ts) and stores it once under a dedupe key.
 *
 * Hooks never throw and never slow the action down meaningfully: an alert is a
 * convenience, the scoring and scheduling they follow are what matter. If the
 * outbox tables are missing (before the migration), the insert fails and is logged.
 */
import { after } from "next/server";
import { db } from "../supabase";
import type { Match, Team, Tie } from "../types";
import { RUBBER_LABELS } from "../tennis/ties";
import { aboutTime } from "../friendly/scheduler";
import type { RubberType } from "../types";
import {
  STARTING_LEAD_MINUTES,
  composeAnnouncement,
  composeLineups,
  composeMatchFinished,
  composeMatchLive,
  composeMatchScheduled,
  composeNightMatch,
  composeTieDecided,
  composeTieSchedule,
  composeTieStarting,
  type AlertKind,
  type AlertPayload,
  type Side,
} from "./compose";
import type { AlertTranslations } from "./i18n";
import { DEFERRED_LIVE_ACTIVITY, LIVE_ACTIVITY_BUCKET_MS, SCORE_ALERT_KINDS } from "../live/delay";
import { audienceMatch, scoreDelayFor } from "../live/delayServer";

async function enqueue(row: {
  kind: AlertKind | typeof DEFERRED_LIVE_ACTIVITY;
  tournamentId: string | null;
  matchId?: string | null;
  tieId?: string | null;
  dedupeKey: string;
  payload: AlertPayload;
  fireAt?: string;
}) {
  // The audience delay (Admin → In the app → Score delay): an alert that tells how
  // play is going goes out when the fans' screens show it, `seconds` later, through
  // the scheduled drain (as the call reminder does). Calls to court never wait.
  let fireAt = row.fireAt;
  if (!fireAt && row.tournamentId && SCORE_ALERT_KINDS.has(row.kind)) {
    const delay = await scoreDelayFor(row.tournamentId);
    if (delay > 0) {
      fireAt = new Date(Date.now() + delay * 1000).toISOString();
      lateKick(delay * 1000);
    }
  }
  const { error } = await db()
    .from("notification_events")
    .upsert(
      {
        kind: row.kind,
        tournament_id: row.tournamentId,
        match_id: row.matchId ?? null,
        tie_id: row.tieId ?? null,
        dedupe_key: row.dedupeKey,
        payload: row.payload,
        fire_at: fireAt ?? new Date().toISOString(),
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
  if (error) console.error("notification enqueue failed", row.kind, error.message);
}

/** Sends due alerts after the response, inside the same request. */
function kick() {
  try {
    after(async () => {
      const { drainNotifications } = await import("./drain");
      await drainNotifications();
    });
  } catch {
    // Outside a request (a script): the scheduled drain picks it up.
  }
}

/**
 * Sends what falls due `ms` from now, still inside this request (after the
 * response). Best effort: the scheduled drain (every minute) sends it otherwise.
 */
function lateKick(ms: number) {
  try {
    after(async () => {
      await new Promise((r) => setTimeout(r, ms + 1_000));
      const { drainNotifications } = await import("./drain");
      await drainNotifications();
    });
  } catch {
    // Outside a request (a script): the scheduled drain picks it up.
  }
}

/** Runs after the response when inside a request; at once from a script. Never throws. */
async function later(label: string, fn: () => Promise<void>) {
  const run = async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`notify ${label} failed`, err);
    }
  };
  try {
    after(run);
  } catch {
    await run();
  }
}

async function safely(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    kick();
  } catch (err) {
    console.error(`notify ${label} failed`, err);
  }
}

interface Ctx {
  tournament: { id: string; name: string; timezone: string };
  teams: Map<string, Pick<Team, "id" | "team_name" | "nation_code"> & { players: { id: string; full_name: string }[] }>;
  courts: Map<string, string>;
}

async function context(tournamentId: string): Promise<Ctx> {
  const [{ data: t }, { data: teams }, { data: courts }] = await Promise.all([
    db().from("tournaments").select("id, name, timezone").eq("id", tournamentId).single(),
    db().from("teams").select("id, team_name, nation_code, players(id, full_name)").eq("tournament_id", tournamentId),
    db().from("courts").select("id, court_name").eq("tournament_id", tournamentId),
  ]);
  const tr = t as { id: string; name: string; timezone?: string | null };
  return {
    tournament: { id: tr.id, name: tr.name, timezone: tr.timezone || "Africa/Cairo" },
    teams: new Map(((teams ?? []) as (Team & { players: { id: string; full_name: string }[] })[]).map((x) => [x.id, x])),
    courts: new Map(((courts ?? []) as { id: string; court_name: string }[]).map((c) => [c.id, c.court_name])),
  };
}

function side(ctx: Ctx, teamId: string | null): Side {
  const t = teamId ? ctx.teams.get(teamId) : undefined;
  return { name: t?.team_name ?? "TBD", code: t?.nation_code ?? null };
}

function surname(full: string): string {
  return full.trim().split(/\s+/).slice(-1)[0] ?? full;
}

/** The people on court: a rubber's nominees, or the whole team. */
function sidePlayers(ctx: Ctx, teamId: string | null, nominees: string[] | null | undefined) {
  const t = teamId ? ctx.teams.get(teamId) : undefined;
  const all = t?.players ?? [];
  return nominees?.length ? all.filter((p) => nominees.includes(p.id)) : all;
}

function sideLabel(ctx: Ctx, m: Pick<Match, "tie_id" | "team_a_id" | "team_b_id" | "team_a_player_ids" | "team_b_player_ids">, s: "A" | "B") {
  const teamId = s === "A" ? m.team_a_id : m.team_b_id;
  const nominees = s === "A" ? m.team_a_player_ids : m.team_b_player_ids;
  const sd = side(ctx, teamId);
  if (!m.tie_id) return sd.name;
  const players = sidePlayers(ctx, teamId, nominees);
  return players.length ? `${players.map((p) => surname(p.full_name)).join(" / ")} (${sd.code ?? sd.name})` : sd.code ?? sd.name;
}

/* ---------------- match day (src/lib/matchday/server.ts) ---------------- */

export type AlertContext = Ctx;

/** Names for a tournament's alerts: teams with their players (id and name only), courts. */
export function alertContext(tournamentId: string): Promise<AlertContext> {
  return context(tournamentId);
}

/** A side as the alerts name it: the team, or "Popa / Grant (ROU)" in a rubber. */
export function alertSideLabel(ctx: AlertContext, m: Pick<Match, "tie_id" | "team_a_id" | "team_b_id" | "team_a_player_ids" | "team_b_player_ids">, s: "A" | "B"): string {
  return sideLabel(ctx, m, s);
}

/** The player row ids on one side of a match: a rubber's nominees, or the whole team. */
export function alertSidePlayerIds(ctx: AlertContext, m: Pick<Match, "team_a_id" | "team_b_id" | "team_a_player_ids" | "team_b_player_ids">, s: "A" | "B"): string[] {
  return sidePlayers(ctx, s === "A" ? m.team_a_id : m.team_b_id, s === "A" ? m.team_a_player_ids : m.team_b_player_ids).map((p) => p.id);
}

/**
 * Stores a match-day alert once under its dedupe key and sends what is due. A
 * `fireAt` in the future waits for the scheduled drain (the call reminder).
 * Never throws.
 */
export function enqueueAlert(row: {
  kind: AlertKind;
  tournamentId: string;
  matchId: string;
  tieId?: string | null;
  dedupeKey: string;
  payload: AlertPayload;
  fireAt?: string;
}): Promise<void> {
  return safely(row.kind, () => enqueue(row));
}

/* ---------------- ties ---------------- */

export function notifyTieScheduled(tieId: string, previous: { court_id: string | null; scheduled_time: string | null } | null) {
  return safely("tie scheduled", async () => {
    const { data } = await db().from("ties").select("*").eq("id", tieId).single();
    const tie = data as Tie | null;
    if (!tie || !tie.team_a_id || !tie.team_b_id) return;
    const ctx = await context(tie.tournament_id);
    const court = tie.court_id ? ctx.courts.get(tie.court_id) ?? null : null;
    const moved = Boolean(previous?.scheduled_time || previous?.court_id);
    const kind = moved ? "tie_rescheduled" : "tie_scheduled";
    await enqueue({
      kind,
      tournamentId: tie.tournament_id,
      tieId,
      dedupeKey: `tie:${tieId}:sched:${tie.court_id ?? "-"}:${tie.scheduled_time ?? "-"}`,
      payload: composeTieSchedule({
        kind,
        tieId,
        tournamentId: tie.tournament_id,
        a: side(ctx, tie.team_a_id),
        b: side(ctx, tie.team_b_id),
        court,
        at: tie.scheduled_time,
        timeZone: ctx.tournament.timezone,
        eventName: ctx.tournament.name,
      }),
    });
    // The "starting soon" reminder follows the latest time; older ones are withdrawn.
    await db().from("notification_events").update({ status: "cancelled" }).eq("tie_id", tieId).eq("kind", "tie_starting").eq("status", "pending");
    if (tie.scheduled_time) {
      const fireAt = new Date(Date.parse(tie.scheduled_time) - STARTING_LEAD_MINUTES * 60_000);
      if (fireAt.getTime() > Date.now()) {
        await enqueue({
          kind: "tie_starting",
          tournamentId: tie.tournament_id,
          tieId,
          dedupeKey: `tie:${tieId}:soon:${tie.scheduled_time}:${tie.court_id ?? "-"}`,
          fireAt: fireAt.toISOString(),
          payload: composeTieStarting({ tieId, a: side(ctx, tie.team_a_id), b: side(ctx, tie.team_b_id), court, at: tie.scheduled_time, timeZone: ctx.tournament.timezone }),
        });
        // A cancelled row with the same key would block re-scheduling back to an earlier time.
        await db()
          .from("notification_events")
          .update({ status: "pending" })
          .eq("dedupe_key", `tie:${tieId}:soon:${tie.scheduled_time}:${tie.court_id ?? "-"}`)
          .eq("status", "cancelled");
      }
    }
    await coachTieSoonAlerts(tie, ctx, court);
  });
}

export function notifyLineups(tieId: string) {
  return safely("lineups", async () => {
    const { data } = await db().from("ties").select("*").eq("id", tieId).single();
    const tie = data as Tie | null;
    if (!tie) return;
    const ctx = await context(tie.tournament_id);
    const { data: rubbers } = await db()
      .from("matches")
      .select("rubber_type, team_a_id, team_b_id, team_a_player_ids, team_b_player_ids, tie_id")
      .eq("tie_id", tieId)
      .order("rubber_no");
    const rows = ((rubbers ?? []) as Pick<Match, "rubber_type" | "team_a_id" | "team_b_id" | "team_a_player_ids" | "team_b_player_ids" | "tie_id">[]).map((r) => ({
      label: RUBBER_LABELS[r.rubber_type as RubberType] ?? String(r.rubber_type),
      a: sidePlayers(ctx, r.team_a_id, r.team_a_player_ids).map((p) => surname(p.full_name)).join(" / ") || "TBD",
      b: sidePlayers(ctx, r.team_b_id, r.team_b_player_ids).map((p) => surname(p.full_name)).join(" / ") || "TBD",
    }));
    await enqueue({
      kind: "lineups",
      tournamentId: tie.tournament_id,
      tieId,
      dedupeKey: `tie:${tieId}:lineup:${rows.map((r) => r.a + r.b).join("|")}`,
      payload: composeLineups({ tieId, a: side(ctx, tie.team_a_id), b: side(ctx, tie.team_b_id), rubbers: rows }),
    });
  });
}

export function notifyTieDecided(tieId: string) {
  return safely("tie decided", async () => {
    const { data } = await db().from("ties").select("*").eq("id", tieId).single();
    const tie = data as Tie | null;
    if (!tie?.winner_team_id) return;
    const ctx = await context(tie.tournament_id);
    const winnerIsA = tie.winner_team_id === tie.team_a_id;
    const w = side(ctx, tie.winner_team_id);
    const l = side(ctx, winnerIsA ? tie.team_b_id : tie.team_a_id);
    const score = winnerIsA ? `${tie.rubbers_a}–${tie.rubbers_b}` : `${tie.rubbers_b}–${tie.rubbers_a}`;
    const stageLabel =
      tie.stage === "placement"
        ? tie.places_from === 1 && tie.places_to === 2
          ? `Final · ${ctx.tournament.name}`
          : `${tie.round_name ?? "Placement"} · ${ctx.tournament.name}`
        : `Group stage · ${ctx.tournament.name}`;
    await enqueue({
      kind: "tie_decided",
      tournamentId: tie.tournament_id,
      tieId,
      dedupeKey: `tie:${tieId}:decided:${tie.winner_team_id}`,
      payload: composeTieDecided({ tieId, winner: w, loser: l, rubbers: score, stageLabel }),
    });
    await forCoaches(ctx, tie, async (teamId, us, them, s) => ({
      kind: "coach_tie_result",
      dedupeKey: `coach:${teamId}:tie:${tieId}:decided:${tie.winner_team_id}`,
      payload: (await coachWords()).coachTieResult({
        us,
        them,
        tieId,
        won: tie.winner_team_id === teamId,
        rubbers: s === "A" ? `${tie.rubbers_a}–${tie.rubbers_b}` : `${tie.rubbers_b}–${tie.rubbers_a}`,
        stage: stageLabel,
      }),
    }), { tieId });
  });
}

/**
 * National team coaches (migration 0037): one side's line-up of a tie was entered or
 * changed. Its coaches hear their own players only (never the opponents' line-up).
 */
export function notifyCoachLineup(tieId: string, s: "A" | "B", late: boolean) {
  return safely("coach line-up", async () => {
    const { data } = await db().from("ties").select("*").eq("id", tieId).single();
    const tie = data as Tie | null;
    const teamId = tie ? (s === "A" ? tie.team_a_id : tie.team_b_id) : null;
    if (!tie || !teamId) return;
    const ctx = await context(tie.tournament_id);
    const { data: rubbers } = await db().from("matches").select("rubber_type, team_a_id, team_b_id, team_a_player_ids, team_b_player_ids, tie_id").eq("tie_id", tieId).order("rubber_no");
    const rows = ((rubbers ?? []) as Pick<Match, "rubber_type" | "team_a_id" | "team_b_id" | "team_a_player_ids" | "team_b_player_ids" | "tie_id">[]).map((r) => ({
      label: RUBBER_LABELS[r.rubber_type as RubberType] ?? String(r.rubber_type),
      players: (s === "A" ? r.team_a_player_ids : r.team_b_player_ids)?.length ? sidePlayers(ctx, teamId, s === "A" ? r.team_a_player_ids : r.team_b_player_ids).map((p) => p.full_name) : [],
    }));
    const key = rows.map((r) => r.players.join("+")).join("|");
    await forCoaches(ctx, s === "A" ? { team_a_id: teamId, team_b_id: null } : { team_a_id: null, team_b_id: teamId }, async (id, us) => ({
      kind: "coach_lineup",
      dedupeKey: `coach:${id}:tie:${tieId}:lineup:${key}`,
      payload: (await coachWords()).coachLineup({ us, them: coachCode(ctx, s === "A" ? tie.team_b_id : tie.team_a_id), tieId, rubbers: rows, late }),
    }), { tieId });
  });
}

/* ---------------- national team coaches (migration 0037) ---------------- */

const coachWords = () => import("../coaches/alerts");

function coachCode(ctx: Ctx, teamId: string | null): string | null {
  if (!teamId) return null;
  const sd = side(ctx, teamId);
  return sd.code ?? sd.name;
}

function rubberLabel(m: Pick<Match, "rubber_type" | "round_name">): string {
  return m.rubber_type ? (RUBBER_LABELS[m.rubber_type as RubberType] ?? String(m.rubber_type)) : (m.round_name ?? "Match");
}

/** The coach's own players on court in this match (full names; a rubber's nominees). */
function coachPlayers(ctx: Ctx, m: Pick<Match, "team_a_id" | "team_b_id" | "team_a_player_ids" | "team_b_player_ids">, teamId: string): string[] {
  const s = m.team_a_id === teamId ? "A" : "B";
  const nominees = s === "A" ? m.team_a_player_ids : m.team_b_player_ids;
  return nominees?.length ? sidePlayers(ctx, teamId, nominees).map((p) => p.full_name) : [];
}

/**
 * One outbox row per side whose team has a working coach code, targeted at that team's
 * coach phones. `build` gets the team, its label, the opponent's code and its side.
 */
async function forCoaches(
  ctx: Ctx,
  row: { team_a_id: string | null; team_b_id: string | null; id?: string; tie_id?: string | null },
  build: (teamId: string, us: { teamId: string; code: string }, them: string | null, s: "A" | "B") => Promise<{ kind: AlertKind; dedupeKey: string; payload: AlertPayload; fireAt?: string } | null>,
  ids: { tieId?: string | null } = {},
) {
  const { teamsWithCoaches } = await import("../coaches/server");
  const coached = new Set(await teamsWithCoaches([row.team_a_id, row.team_b_id]));
  for (const s of ["A", "B"] as const) {
    const teamId = s === "A" ? row.team_a_id : row.team_b_id;
    if (!teamId || !coached.has(teamId)) continue;
    const made = await build(teamId, { teamId, code: coachCode(ctx, teamId)! }, coachCode(ctx, s === "A" ? row.team_b_id : row.team_a_id), s);
    if (!made) continue;
    const isMatch = "tie_id" in row && row.id;
    await enqueue({
      kind: made.kind,
      tournamentId: ctx.tournament.id,
      matchId: isMatch ? row.id : null,
      tieId: ids.tieId ?? (isMatch ? (row.tie_id ?? null) : (row.id ?? null)),
      dedupeKey: made.dedupeKey,
      payload: made.payload,
      fireAt: made.fireAt,
    });
  }
}

/** "Starts in 5 minutes" for the tie's coaches, following its latest time (older ones withdrawn). */
async function coachTieSoonAlerts(tie: Tie, ctx: Ctx, court: string | null) {
  const { COACH_SOON_MINUTES, tieStageLabel } = await import("../coaches/rules");
  await db().from("notification_events").update({ status: "cancelled" }).eq("tie_id", tie.id).eq("kind", "coach_soon").is("match_id", null).eq("status", "pending");
  if (!tie.scheduled_time) return;
  const fireAt = Date.parse(tie.scheduled_time) - COACH_SOON_MINUTES * 60_000;
  if (!(fireAt > Date.now())) return;
  const { data: g } = tie.group_id ? await db().from("groups").select("group_name").eq("id", tie.group_id).maybeSingle() : { data: null };
  const stage = tieStageLabel(tie, (g as { group_name: string } | null)?.group_name ?? null);
  const keys: string[] = [];
  await forCoaches(ctx, { team_a_id: tie.team_a_id, team_b_id: tie.team_b_id, id: tie.id }, async (teamId, us, them) => {
    const dedupeKey = `coach:${teamId}:tie:${tie.id}:soon:${tie.scheduled_time}:${tie.court_id ?? "-"}`;
    keys.push(dedupeKey);
    return {
      kind: "coach_soon",
      dedupeKey,
      fireAt: new Date(fireAt).toISOString(),
      payload: (await coachWords()).coachTieSoon({ us, them, tieId: tie.id, court, at: tie.scheduled_time!, timeZone: ctx.tournament.timezone, stage }),
    };
  });
  // Moving the tie back to an earlier time again: its withdrawn reminder comes back.
  if (keys.length) await db().from("notification_events").update({ status: "pending" }).in("dedupe_key", keys).eq("status", "cancelled");
}

/** Match day: the coaches of a rubber that is next on its court (the match on court is one game from the end). */
export function notifyCoachesRubberSoon(match: Match, court: string) {
  return safely("coach soon", async () => {
    const ctx = await context(match.tournament_id);
    await forCoaches(ctx, match, async (teamId, us, them) => ({
      kind: "coach_soon",
      dedupeKey: `coach:${teamId}:match:${match.id}:soon`,
      payload: (await coachWords()).coachRubberSoon({ us, them, matchId: match.id, court, label: rubberLabel(match), players: coachPlayers(ctx, match, teamId) }),
    }));
  });
}

/** Match day: the coaches of a match called to its court (once per call). */
export function notifyCoachesCalled(match: Match, o: { court: string; deadline: string; calledAt: string }) {
  return safely("coach called", async () => {
    const ctx = await context(match.tournament_id);
    await forCoaches(ctx, match, async (teamId, us, them) => ({
      kind: "coach_called",
      dedupeKey: `coach:${teamId}:match:${match.id}:call:${Date.parse(o.calledAt)}`,
      payload: (await coachWords()).coachCalled({ us, them, matchId: match.id, court: o.court, label: rubberLabel(match), players: coachPlayers(ctx, match, teamId), deadline: o.deadline, timeZone: ctx.tournament.timezone }),
    }));
  });
}

/* ---------------- matches ---------------- */

export function notifyMatchLive(match: Match) {
  return safely("match live", async () => {
    const ctx = await context(match.tournament_id);
    const players = [
      ...sidePlayers(ctx, match.team_a_id, match.team_a_player_ids),
      ...sidePlayers(ctx, match.team_b_id, match.team_b_player_ids),
    ];
    await enqueue({
      kind: "match_live",
      tournamentId: match.tournament_id,
      matchId: match.id,
      tieId: match.tie_id ?? null,
      dedupeKey: `match:${match.id}:live`,
      payload: composeMatchLive({
        matchId: match.id,
        tieId: match.tie_id ?? null,
        label: match.round_name ?? ctx.tournament.name,
        a: sideLabel(ctx, match, "A"),
        b: sideLabel(ctx, match, "B"),
        court: match.court_id ? ctx.courts.get(match.court_id) ?? null : null,
        playerIds: players.map((p) => p.id),
        nations: [side(ctx, match.team_a_id), side(ctx, match.team_b_id)],
      }),
    });
    await forCoaches(ctx, match, async (teamId, us, them) => ({
      kind: "coach_started",
      dedupeKey: `coach:${teamId}:match:${match.id}:live`,
      payload: (await coachWords()).coachStarted({
        us,
        them,
        matchId: match.id,
        court: match.court_id ? ctx.courts.get(match.court_id) ?? null : null,
        label: rubberLabel(match),
        players: coachPlayers(ctx, match, teamId),
      }),
    }));
    await later("live activity start", async () => {
      // With the audience delay on, the lock-screen card starts when the fans' screens show the match live.
      if (await deferLiveActivity(match, "live")) return;
      await liveActivityPhase(match, ctx, { phase: "live" });
    });
  });
}

/* ---------------- lock screen behind the audience delay ---------------- */

export type DeferredLiveActivityOp = "score" | "live" | "end";

/**
 * With the tournament's audience delay on, holds a lock-screen push back: an
 * outbox row due `seconds` later (a second's margin, so the match's own times are
 * inside the view then) that the drain turns into the push (runDeferredLiveActivity),
 * built from the audience view at that moment. Pushes of one match within
 * LIVE_ACTIVITY_BUCKET_MS share a row. Returns false (nothing held) when the delay is off.
 */
export async function deferLiveActivity(match: Pick<Match, "id" | "tournament_id" | "tie_id">, op: DeferredLiveActivityOp, important = false): Promise<boolean> {
  const delay = await scoreDelayFor(match.tournament_id);
  if (!delay) return false;
  const fireMs = Date.now() + delay * 1000 + 1_000;
  const bucket = Math.floor(fireMs / LIVE_ACTIVITY_BUCKET_MS);
  await enqueue({
    kind: DEFERRED_LIVE_ACTIVITY,
    tournamentId: match.tournament_id,
    matchId: match.id,
    tieId: match.tie_id ?? null,
    dedupeKey: `la:${op}:${important ? 1 : 0}:${match.id}:${bucket}`,
    fireAt: new Date(fireMs).toISOString(),
    // Never sent as an alert: the drain hands `deferred` to runDeferredLiveActivity.
    payload: { title: "", body: "", url: "", targets: [], category: "live", deferred: { op, matchId: match.id, important } } as AlertPayload,
  });
  lateKick(delay * 1000 + 1_000);
  return true;
}

/** The drain's half of deferLiveActivity: the push, from what the audience sees now. Never throws. */
export async function runDeferredLiveActivity(d: { op?: string; matchId?: string; important?: boolean } | null | undefined): Promise<void> {
  try {
    if (!d?.matchId) return;
    const { data } = await db().from("matches").select("*").eq("id", d.matchId).maybeSingle();
    const match = data as Match | null;
    if (!match) return;
    const ctx = await context(match.tournament_id);
    if (d.op === "live") return await liveActivityPhase(match, ctx, { phase: "live" });
    if (d.op === "end") return await endLiveActivities(match, ctx);
    const { getConfig } = await import("../mobile/server");
    if (!(await getConfig()).flags.live_activity) return;
    const [{ pushLiveActivities, liveState }, { toScore }, { getSnapshot }] = await Promise.all([import("./apns"), import("../mobile/projection"), import("../data")]);
    const seen = await audienceMatch(match, await getSnapshot(match.id));
    const label = (teamId: string | null) => {
      const t = teamId ? ctx.teams.get(teamId) : undefined;
      return t?.nation_code ?? t?.team_name ?? "";
    };
    await pushLiveActivities(
      match.id,
      liveState(toScore(seen.match, seen.snapshot), { a: label(match.team_a_id), b: label(match.team_b_id), court: match.court_id ? ctx.courts.get(match.court_id) ?? "" : "", status: "Live" }),
      { important: Boolean(d.important) },
    );
  } catch (err) {
    console.error("deferred live activity failed", err);
  }
}

/* ---------------- lock screen (Live Activities) ---------------- */

type UpcomingPhase = { phase: "soon" | "called"; until: number | null; from?: number | null };

/**
 * A match entered a lock-screen phase: "soon" (next on its court), "called" (to
 * court, with the deadline) or "live" (first point). Cards already on lock
 * screens are updated; phones of the match's own players (`autoStartMine`) and of
 * people who starred it (`autoStartStarred`) get a new card by push-to-start when
 * the tournament allows it. The call-to-court flow (Phase 3) calls this with
 * `{ phase: "called", until: deadlineAt, from: calledAt }`; the match-soon check
 * with `{ phase: "soon", until: scheduled time }`.
 */
export function notifyLiveActivityPhase(matchId: string, p: UpcomingPhase | { phase: "live" }) {
  return later("live activity phase", async () => {
    const { data } = await db().from("matches").select("*").eq("id", matchId).maybeSingle();
    const match = data as Match | null;
    if (!match) return;
    await liveActivityPhase(match, await context(match.tournament_id), p);
  });
}

async function liveActivityPhase(match: Match, ctx: Ctx, p: UpcomingPhase | { phase: "live" }) {
  const { getConfig } = await import("../mobile/server");
  if (!(await getConfig()).flags.live_activity) return;
  const { data: t, error } = await db().from("tournaments").select("sport, match_day_rules").eq("id", match.tournament_id).maybeSingle();
  if (error || !t) return; // before migration 0022: no rules, nothing starts by push
  const [{ matchDayRules }, la, apns] = await Promise.all([import("../matchday/rules"), import("./liveActivity"), import("./apns")]);
  const rules = matchDayRules((t as { match_day_rules?: unknown }).match_day_rules, t as { sport?: string | null });
  if (!rules.lockScreen.liveActivities) return;

  const label = (teamId: string | null) => {
    const team = teamId ? ctx.teams.get(teamId) : undefined;
    return team?.nation_code ?? team?.team_name ?? "";
  };
  const court = match.court_id ? ctx.courts.get(match.court_id) ?? "" : "";
  let state: import("./liveActivity").LiveScoreState;
  if (p.phase === "live") {
    const [{ toScore }, { getSnapshot }] = await Promise.all([import("../mobile/projection"), import("../data")]);
    // The score as the audience sees it (the audience delay; the stored one when it is off).
    const seen = await audienceMatch(match, await getSnapshot(match.id));
    state = la.liveState(toScore(seen.match, seen.snapshot), { a: label(match.team_a_id), b: label(match.team_b_id), court, status: "Live" }, { matchId: match.id });
  } else {
    state = la.upcomingState({
      matchId: match.id,
      phase: p.phase,
      a: label(match.team_a_id),
      b: label(match.team_b_id),
      court,
      until: p.until,
      from: p.from ?? null,
      countdown: rules.lockScreen.countdown,
    });
  }

  // Cards already showing this match move to the new phase.
  await apns.pushLiveActivities(match.id, state, { important: true });

  if (!la.startByPushAllowed(rules.lockScreen, p.phase)) return;
  const installs = await liveActivityAudience(match, ctx, {
    mine: rules.lockScreen.autoStartMine,
    starred: rules.lockScreen.autoStartStarred,
    // "Soon" and "called" are match-day calls: a phone that turned those alerts off gets no card either.
    respectCourtPref: p.phase !== "live",
  });
  if (installs.length) await apns.pushToStart(match.id, state, installs);
}

/**
 * The iPhones that should get a card for this match: the players' own (through
 * their claimed player codes) and the phones that starred the match.
 */
async function liveActivityAudience(match: Match, ctx: Ctx, opts: { mine: boolean; starred: boolean; respectCourtPref: boolean }): Promise<string[]> {
  const users = new Set<string>();
  const installs = new Set<string>();
  if (opts.mine) {
    const playerIds = [
      ...sidePlayers(ctx, match.team_a_id, match.team_a_player_ids),
      ...sidePlayers(ctx, match.team_b_id, match.team_b_player_ids),
    ].map((pl) => pl.id);
    if (playerIds.length) {
      const { data } = await db().from("player_claims").select("user_id").in("player_id", playerIds).is("archived_at", null);
      for (const c of (data ?? []) as { user_id: string | null }[]) if (c.user_id) users.add(c.user_id);
    }
  }
  if (opts.starred) {
    const { data } = await db().from("follows").select("owner_kind, owner_id").eq("target_kind", "match").eq("target_key", match.id);
    for (const f of (data ?? []) as { owner_kind: "install" | "user"; owner_id: string }[]) (f.owner_kind === "user" ? users : installs).add(f.owner_id);
  }
  const rows: { installation_id: string; prefs: { court?: boolean } | null }[] = [];
  const cols = "installation_id, prefs";
  const userList = [...users];
  for (let i = 0; i < userList.length; i += 200) {
    const { data } = await db().from("push_devices").select(cols).eq("platform", "ios").is("disabled_at", null).in("user_id", userList.slice(i, i + 200));
    rows.push(...((data ?? []) as typeof rows));
  }
  const installList = [...installs];
  for (let i = 0; i < installList.length; i += 200) {
    const { data } = await db().from("push_devices").select(cols).eq("platform", "ios").is("disabled_at", null).in("installation_id", installList.slice(i, i + 200));
    rows.push(...((data ?? []) as typeof rows));
  }
  return [...new Set(rows.filter((r) => !opts.respectCourtPref || r.prefs?.court !== false).map((r) => r.installation_id))];
}

export function notifyMatchFinished(matchId: string) {
  return safely("match finished", async () => {
    const { data } = await db().from("matches").select("*").eq("id", matchId).single();
    const match = data as Match | null;
    if (!match?.winner_team_id) return;
    const ctx = await context(match.tournament_id);
    const { data: snap } = await db().from("match_score_snapshots").select("completed_sets").eq("match_id", matchId).maybeSingle();
    const winnerIsA = match.winner_team_id === match.team_a_id;
    const sets = ((snap as { completed_sets?: { teamAGames: number; teamBGames: number }[] } | null)?.completed_sets ?? []).map((s) =>
      winnerIsA ? `${s.teamAGames}–${s.teamBGames}` : `${s.teamBGames}–${s.teamAGames}`,
    );
    const players = [
      ...sidePlayers(ctx, match.team_a_id, match.team_a_player_ids),
      ...sidePlayers(ctx, match.team_b_id, match.team_b_player_ids),
    ];
    await enqueue({
      kind: "match_finished",
      tournamentId: match.tournament_id,
      matchId,
      tieId: match.tie_id ?? null,
      dedupeKey: `match:${matchId}:finished:${match.winner_team_id}`,
      payload: composeMatchFinished({
        matchId,
        tieId: match.tie_id ?? null,
        label: match.round_name ?? ctx.tournament.name,
        winner: sideLabel(ctx, match, winnerIsA ? "A" : "B"),
        loser: sideLabel(ctx, match, winnerIsA ? "B" : "A"),
        score: match.status === "completed" ? sets.join(" ") : match.status,
        playerIds: players.map((p) => p.id),
      }),
    });
    const setsOf = (s: "A" | "B") =>
      ((snap as { completed_sets?: { teamAGames: number; teamBGames: number }[] } | null)?.completed_sets ?? []).map((x) => (s === "A" ? `${x.teamAGames}–${x.teamBGames}` : `${x.teamBGames}–${x.teamAGames}`)).join(" ");
    await forCoaches(ctx, match, async (teamId, us, them, s) => ({
      kind: "coach_finished",
      dedupeKey: `coach:${teamId}:match:${matchId}:finished:${match.winner_team_id}`,
      payload: (await coachWords()).coachFinished({ us, them, matchId, label: rubberLabel(match), won: match.winner_team_id === teamId, score: setsOf(s), status: match.status }),
    }));
    await later("live activity end", async () => {
      // With the audience delay on, the card shows the result when the fans' screens do.
      if (await deferLiveActivity(match, "end")) return;
      await endLiveActivities(match, ctx);
    });
  });
}

/**
 * Ends the lock-screen scores of a finished match, whichever path finished it:
 * the referee's last point, an admin result, a walkover or a retirement. (The
 * scoring route also ends them on the last point; ending twice is harmless.)
 */
async function endLiveActivities(match: Match, ctx: Ctx) {
  const { getConfig } = await import("../mobile/server");
  if (!(await getConfig()).flags.live_activity) return;
  const [{ pushLiveActivities, liveState }, { toScore }, { getSnapshot }] = await Promise.all([
    import("./apns"),
    import("../mobile/projection"),
    import("../data"),
  ]);
  const latest = await getSnapshot(match.id);
  const label = (teamId: string | null) => {
    const t = teamId ? ctx.teams.get(teamId) : undefined;
    return t?.nation_code ?? t?.team_name ?? "";
  };
  // As the audience sees it (the audience delay; the stored rows when it is off).
  const seen = await audienceMatch(match, latest);
  const status = seen.match.status === "completed" ? "Final" : seen.match.status.charAt(0).toUpperCase() + seen.match.status.slice(1);
  await pushLiveActivities(
    match.id,
    liveState(toScore(seen.match, seen.snapshot), {
      a: label(match.team_a_id),
      b: label(match.team_b_id),
      court: match.court_id ? ctx.courts.get(match.court_id) ?? "" : "",
      status,
    }),
    { end: true },
  );
}

/**
 * A match's court and time are set. `night` (a league night's published table,
 * src/lib/friendly/nights.ts): the time is an estimate ("about 19:40") and the
 * alert goes to the match's players only, through their own accounts.
 */
export function notifyMatchScheduled(matchId: string, opts: { night?: { position: number | null } } = {}) {
  return safely("match scheduled", async () => {
    const { data } = await db().from("matches").select("*").eq("id", matchId).single();
    const m = data as Match | null;
    if (!m || !m.team_a_id || !m.team_b_id || m.tie_id) return;
    const ctx = await context(m.tournament_id);
    const court = m.court_id ? ctx.courts.get(m.court_id) ?? null : null;
    const players = [...sidePlayers(ctx, m.team_a_id, null), ...sidePlayers(ctx, m.team_b_id, null)];
    if (opts.night) {
      const { data: s } = await db().from("friendly_sessions").select("name").eq("tournament_id", m.tournament_id).maybeSingle();
      await enqueue({
        kind: "match_scheduled",
        tournamentId: m.tournament_id,
        matchId: m.id,
        // A new court or time is news again; publishing the same table twice is not.
        dedupeKey: `match:${m.id}:night:${m.court_id ?? "-"}:${m.scheduled_time ?? "-"}`,
        payload: composeNightMatch({
          matchId: m.id,
          a: side(ctx, m.team_a_id),
          b: side(ctx, m.team_b_id),
          court,
          position: opts.night.position,
          about: m.scheduled_time ? aboutTime(Date.parse(m.scheduled_time), ctx.tournament.timezone) : null,
          eventName: (s as { name: string } | null)?.name ?? ctx.tournament.name,
          playerIds: players.map((p) => p.id),
        }),
      });
      return;
    }
    await enqueue({
      kind: "match_scheduled",
      tournamentId: m.tournament_id,
      matchId: m.id,
      dedupeKey: `match:${m.id}:sched:${m.court_id ?? "-"}:${m.scheduled_time ?? "-"}`,
      payload: composeMatchScheduled({
        matchId: m.id,
        a: side(ctx, m.team_a_id),
        b: side(ctx, m.team_b_id),
        court,
        at: m.scheduled_time,
        timeZone: ctx.tournament.timezone,
        eventName: ctx.tournament.name,
        playerIds: players.map((p) => p.id),
      }),
    });
  });
}

export function notifyAnnouncement(announcementId: string) {
  return safely("announcement", async () => {
    const { data } = await db().from("announcements").select("*").eq("id", announcementId).single();
    const a = data as { id: string; title: string; body: string | null; level: string; tournament_id: string | null; event_group_id: string | null } | null;
    if (!a || a.level !== "major") return;
    const { data: t } = a.tournament_id ? await db().from("tournaments").select("slug").eq("id", a.tournament_id).maybeSingle() : { data: null };
    await enqueue({
      kind: "announcement",
      tournamentId: a.tournament_id,
      dedupeKey: `announcement:${a.id}`,
      payload: composeAnnouncement({ id: a.id, title: a.title, body: a.body, tournamentId: a.tournament_id, tournamentSlug: (t as { slug?: string } | null)?.slug ?? null, eventGroupId: a.event_group_id }),
    });
  });
}

/**
 * The organiser set play delayed / suspended / resumed and asked for a push
 * (Admin → In the app → Play status): everyone following the tournament or its
 * event group. Once per saved status (dedupe on its time).
 */
export function notifyPlayStatus(o: { tournamentId: string; title: string; body: string; updatedAt: string; tr?: AlertTranslations }) {
  return safely("play status", async () => {
    const { data: t } = await db().from("tournaments").select("slug, event_group_id").eq("id", o.tournamentId).maybeSingle();
    const row = t as { slug?: string; event_group_id?: string | null } | null;
    await enqueue({
      kind: "announcement",
      tournamentId: o.tournamentId,
      dedupeKey: `play_status:${o.tournamentId}:${o.updatedAt}`,
      payload: composeAnnouncement({
        id: `play-status-${o.updatedAt}`,
        title: o.title,
        body: o.body,
        tournamentId: o.tournamentId,
        tournamentSlug: row?.slug ?? null,
        eventGroupId: row?.event_group_id ?? null,
        tr: o.tr,
      }),
    });
  });
}

/**
 * A console announcement (Announcements → App push) to everyone following a
 * nation, or to every app user. Tournament audiences go through the in-app
 * announcement and notifyAnnouncement instead, so they also appear in the feed.
 */
export function notifyBroadcast(o: { id: string; title: string; body: string; target: { kind: "nation"; code: string } | { kind: "all" } }) {
  return safely("broadcast", async () => {
    await enqueue({
      kind: "announcement",
      tournamentId: null,
      dedupeKey: `broadcast:${o.id}`,
      payload: {
        title: o.title.slice(0, 120),
        body: o.body.slice(0, 600),
        url: "movescore://discover",
        targets: [o.target.kind === "all" ? { kind: "all", key: "all" } : { kind: "nation", key: o.target.code }],
        category: "major",
      },
    });
  });
}
