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
import type { RubberType } from "../types";
import {
  STARTING_LEAD_MINUTES,
  composeAnnouncement,
  composeLineups,
  composeMatchFinished,
  composeMatchLive,
  composeTieDecided,
  composeTieSchedule,
  composeTieStarting,
  type AlertKind,
  type AlertPayload,
  type Side,
} from "./compose";

async function enqueue(row: {
  kind: AlertKind;
  tournamentId: string | null;
  matchId?: string | null;
  tieId?: string | null;
  dedupeKey: string;
  payload: AlertPayload;
  fireAt?: string;
}) {
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
        fire_at: row.fireAt ?? new Date().toISOString(),
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
  });
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
    await later("live activity end", () => endLiveActivities(match, ctx));
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
  const status = match.status === "completed" ? "Final" : match.status.charAt(0).toUpperCase() + match.status.slice(1);
  await pushLiveActivities(
    match.id,
    liveState(toScore(match, latest), {
      a: label(match.team_a_id),
      b: label(match.team_b_id),
      court: match.court_id ? ctx.courts.get(match.court_id) ?? "" : "",
      status,
    }),
    { end: true },
  );
}

export function notifyMatchScheduled(matchId: string) {
  return safely("match scheduled", async () => {
    const { data } = await db().from("matches").select("*").eq("id", matchId).single();
    const m = data as Match | null;
    if (!m || !m.team_a_id || !m.team_b_id || m.tie_id) return;
    const ctx = await context(m.tournament_id);
    const court = m.court_id ? ctx.courts.get(m.court_id) ?? null : null;
    const players = [...sidePlayers(ctx, m.team_a_id, null), ...sidePlayers(ctx, m.team_b_id, null)];
    const payload = composeTieSchedule({
      kind: "tie_rescheduled",
      tieId: m.id,
      tournamentId: m.tournament_id,
      a: side(ctx, m.team_a_id),
      b: side(ctx, m.team_b_id),
      court,
      at: m.scheduled_time,
      timeZone: ctx.tournament.timezone,
      eventName: ctx.tournament.name,
    });
    await enqueue({
      kind: "match_scheduled",
      tournamentId: m.tournament_id,
      matchId: m.id,
      dedupeKey: `match:${m.id}:sched:${m.court_id ?? "-"}:${m.scheduled_time ?? "-"}`,
      payload: {
        ...payload,
        title: `Court and time: ${side(ctx, m.team_a_id).name} v ${side(ctx, m.team_b_id).name}`,
        url: `movescore://match/${m.id}`,
        targets: [{ kind: "match", key: m.id }, ...players.map((p) => ({ kind: "player" as const, key: p.id }))],
      },
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
