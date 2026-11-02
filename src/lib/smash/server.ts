/**
 * Smash import, the server run (route `api/internal/smash/import`, pg_cron every 2 minutes,
 * supabase/ops/smash_import_cron.sql): copies FINISHED results from Smash Sporting Club's public
 * scores feed into the two Cairo events, for the courts Move Score does not score itself.
 *
 * One run: fetch Smash (8 s timeout, no cache) → nothing finished off courts 13/14 means no
 * database read at all → take the run lock → read our side with explicit columns → planImport
 * (plan.ts) → enter at most MAX_PER_RUN results, one at a time, PAUSE_MS apart, each through
 * `enterFinalResult` (scoring/append.ts, the admin "Enter final score" path) as role "system":
 *   - just before each write the rubber is read again (scheduled/ready, last event 0, no score event);
 *   - append.ts itself refuses a RESULT_ENTERED over any score from a role that is not admin/manager
 *     (correctionCut), so this importer can never overwrite or correct anything;
 *   - a scoring device holding the match refuses it too (device lock).
 * Each result entered also gets an audit row SMASH_RESULT_IMPORTED by "Smash import".
 *
 * Overlapping runs: the lock is a `takeRateLimit` bucket of one per 110 s (compare-and-set), handed
 * back when the run ends, so two runs can never both write. Running twice never enters twice: the
 * rubber has a result after the first.
 */
import { audit } from "../audit";
import { db } from "../supabase";
import { refundRateLimit, takeRateLimit } from "../ratelimit";
import { enterFinalResult, type AppendOptions } from "../scoring/append";
import { parseSmashSchedule, type SmashSchedule } from "./feed";
import { OWN_COURTS, SMASH_EVENT_SLUGS, planImport, type OurSide, type PlanItem } from "./plan";

export const SMASH_FEED_DEFAULT = "https://scores.sscsportsacademy.com";
const FETCH_TIMEOUT_MS = 8_000;
/** At most this many results per run, so a run never bursts (the next run takes the rest). */
export const MAX_PER_RUN = 6;
const PAUSE_MS = 3_000;
const LOCK = { key: "smash-import:run", limit: 1, windowSeconds: 110 };
const ACTOR = "smash-import";
const ACTOR_NAME = "Smash import";

export interface SmashImportSummary {
  ok: boolean;
  error?: string;
  busy?: boolean;
  entered: { court: number; ours: string | null; score: string }[];
  /** Not entered: for the desk to enter by hand (or entered by someone else meanwhile). */
  desk: { court: number; ours: string | null; smash: string; why: string }[];
  skipped: number;
  skippedList: string[];
  /** Ready to enter but left for the next run (MAX_PER_RUN). */
  waiting: number;
}

const empty = (): SmashImportSummary => ({ ok: true, entered: [], desk: [], skipped: 0, skippedList: [], waiting: 0 });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deskRow = (p: PlanItem, why = p.why) => ({ court: p.court, ours: p.ours, smash: p.smash, why });

function feedUrl(): string {
  const base = (process.env.SMASH_FEED_URL ?? "").trim() || SMASH_FEED_DEFAULT;
  if (!/^https?:\/\//i.test(base)) throw new Error("SMASH_FEED_URL must be an http(s) address");
  return `${base.replace(/\/+$/, "")}/api/public/schedule`;
}

export async function fetchSmash(): Promise<SmashSchedule> {
  const res = await fetch(feedUrl(), { cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Smash schedule: HTTP ${res.status}`);
  return parseSmashSchedule(await res.json());
}

/** Our side of the two events, only the ties on the courts Smash has finished matches on. Explicit columns. */
export async function loadOurSide(courtNumbers: Set<number>): Promise<OurSide> {
  const { data: evs, error } = await db().from("tournaments").select("id, slug, sport, scoring_config").in("slug", [...SMASH_EVENT_SLUGS]);
  if (error) throw new Error(`tournaments: ${error.message}`);
  const events = ((evs ?? []) as { id: string; slug: string; sport: string | null; scoring_config: unknown }[]).map((e) => ({ ...e }));
  const ours: OurSide = { events, courts: [], teams: [], players: [], ties: [], rubbers: [] };
  if (events.length === 0) return ours;
  const tids = events.map((e) => e.id);
  const wanted = new Set([...courtNumbers].map((n) => `court ${n}`));
  const [{ data: courts }, { data: teams }, { data: ties }] = await Promise.all([
    db().from("courts").select("id, tournament_id, court_name").in("tournament_id", tids),
    db().from("teams").select("id, tournament_id, nation_code").in("tournament_id", tids),
    db().from("ties").select("id, tournament_id, court_id, scheduled_time, team_a_id, team_b_id, round_name").in("tournament_id", tids),
  ]);
  ours.courts = ((courts ?? []) as { id: string; tournament_id: string; court_name: string }[])
    .filter((c) => wanted.has(c.court_name.trim().toLowerCase()))
    .map((c) => ({ id: c.id, tournamentId: c.tournament_id, name: c.court_name }));
  ours.teams = ((teams ?? []) as { id: string; tournament_id: string; nation_code: string | null }[]).map((t) => ({ id: t.id, tournamentId: t.tournament_id, code: t.nation_code }));
  const courtIds = new Set(ours.courts.map((c) => c.id));
  type TieRow = { id: string; tournament_id: string; court_id: string | null; scheduled_time: string | null; team_a_id: string | null; team_b_id: string | null; round_name: string | null };
  ours.ties = ((ties ?? []) as TieRow[])
    .filter((t) => t.court_id && courtIds.has(t.court_id))
    .map((t) => ({ id: t.id, tournamentId: t.tournament_id, courtId: t.court_id, scheduledTime: t.scheduled_time, teamA: t.team_a_id, teamB: t.team_b_id, roundName: t.round_name }));
  if (ours.ties.length === 0) return ours;

  const tieIds = ours.ties.map((t) => t.id);
  const teamIds = [...new Set(ours.ties.flatMap((t) => [t.teamA, t.teamB]).filter((x): x is string => !!x))];
  const [{ data: rubbers }, { data: players }] = await Promise.all([
    db()
      .from("matches")
      .select("id, tournament_id, tie_id, rubber_type, stage, status, team_a_id, team_b_id, team_a_player_ids, team_b_player_ids")
      .in("tie_id", tieIds),
    teamIds.length ? db().from("players").select("id, team_id, full_name").in("team_id", teamIds) : Promise.resolve({ data: [] }),
  ]);
  ours.players = ((players ?? []) as { id: string; team_id: string; full_name: string }[]).map((p) => ({ id: p.id, teamId: p.team_id, name: p.full_name }));
  type RubberRow = {
    id: string;
    tournament_id: string;
    tie_id: string;
    rubber_type: string | null;
    stage: string;
    status: string;
    team_a_id: string | null;
    team_b_id: string | null;
    team_a_player_ids: string[] | null;
    team_b_player_ids: string[] | null;
  };
  const rows = (rubbers ?? []) as RubberRow[];
  // Only an unscored rubber can be entered: read its snapshot and events, nobody else's.
  const open = rows.filter((r) => r.status === "scheduled" || r.status === "ready").map((r) => r.id);
  const [{ data: snaps }, { data: evRows }] = open.length
    ? await Promise.all([
        db().from("match_score_snapshots").select("match_id, last_event_number").in("match_id", open),
        db().from("score_events").select("match_id").in("match_id", open).limit(5000),
      ])
    : [{ data: [] }, { data: [] }];
  const last = new Map(((snaps ?? []) as { match_id: string; last_event_number: number | null }[]).map((s) => [s.match_id, s.last_event_number ?? 0]));
  const withEvents = new Set(((evRows ?? []) as { match_id: string }[]).map((e) => e.match_id));
  ours.rubbers = rows.map((r) => ({
    id: r.id,
    tournamentId: r.tournament_id,
    tieId: r.tie_id,
    rubberType: r.rubber_type,
    stage: r.stage,
    status: r.status,
    teamA: r.team_a_id,
    teamB: r.team_b_id,
    aPlayerIds: r.team_a_player_ids,
    bPlayerIds: r.team_b_player_ids,
    lastEventNumber: last.get(r.id) ?? 0,
    hasEvents: withEvents.has(r.id),
  }));
  return ours;
}

/** The rubber is still untouched on Move Score, read again right before writing. */
async function stillUnscored(matchId: string): Promise<string | null> {
  const [{ data: m }, { data: snap }, { count }] = await Promise.all([
    db().from("matches").select("status").eq("id", matchId).maybeSingle(),
    db().from("match_score_snapshots").select("last_event_number").eq("match_id", matchId).maybeSingle(),
    db().from("score_events").select("id", { count: "exact", head: true }).eq("match_id", matchId),
  ]);
  const status = (m as { status: string } | null)?.status;
  if (status !== "scheduled" && status !== "ready") return `now ${status ?? "missing"} on Move Score`;
  if (((snap as { last_event_number: number | null } | null)?.last_event_number ?? 0) > 0 || (count ?? 0) > 0) return "now has a score on Move Score";
  return null;
}

/** One import run. The caller has checked the cron secret and the switch (smashImportSwitch). */
export async function runSmashImport(opts: { defer?: AppendOptions["defer"]; pauseMs?: number } = {}): Promise<SmashImportSummary> {
  const out = empty();
  const smash = await fetchSmash();
  const finished = smash.matches.filter((m) => m.status === "completed" && !OWN_COURTS.has(m.court));
  // Nothing finished off our own courts: no database read at all.
  if (finished.length === 0) return out;

  const lock = await takeRateLimit(LOCK);
  if (!lock.taken || !lock.allowed) return { ...out, busy: true };
  try {
    const ours = await loadOurSide(new Set(finished.map((m) => m.court)));
    const plan = planImport(smash, ours);
    out.desk = plan.desk.map((p) => deskRow(p));
    out.skipped = plan.skipped.length;
    out.skippedList = plan.skipped.map((p) => `Court ${p.court} ${p.ours ?? p.smash}: ${p.why}`);
    const todo = plan.enter.slice(0, MAX_PER_RUN);
    out.waiting = plan.enter.length - todo.length;
    for (const [i, p] of todo.entries()) {
      if (i > 0) await pause(opts.pauseMs ?? PAUSE_MS);
      const changed = await stillUnscored(p.matchId);
      if (changed) {
        out.skipped += 1;
        out.skippedList.push(`Court ${p.court} ${p.ours}: ${changed}`);
        continue;
      }
      const r = await enterFinalResult({ matchId: p.matchId, payload: p.payload, role: "system", actor: ACTOR, defer: opts.defer });
      if (!r.ok) {
        out.desk.push(deskRow(p, `refused by Move Score: ${r.error}${r.conflict ? ` (${r.conflict})` : ""}`));
        continue;
      }
      if (r.winnerTeamId && r.winnerTeamId !== p.winnerTeamId) console.error("[smash-import] winner differs after entry", p.matchId);
      out.entered.push({ court: p.court, ours: p.ours, score: p.why });
      await audit({
        tournament_id: p.tournamentId,
        actor_role: "system",
        actor_name: ACTOR_NAME,
        action: "SMASH_RESULT_IMPORTED",
        entity_type: "match",
        entity_id: p.matchId,
        new_value: { smash_match_id: p.smashId, court: p.court, score: p.why, sets: p.payload.sets, smash: p.smash },
      });
    }
  } finally {
    await refundRateLimit(LOCK).catch(() => undefined);
  }
  return out;
}
