/**
 * Plays the chair-umpire practice events (scripts/demo/umpire-demo.ts) to the end, so the
 * court TVs and the closing ceremony can be rehearsed: every group tie gets its line-ups,
 * every rubber is played point by point through the server functions the events route
 * calls, the placement draws are made, and the placement rounds are played until all 16
 * places are decided. Rubbers an umpire already finished are kept; one left half-scored
 * is played on from the start.
 *
 * Only the two demo slugs are ever touched. The alerts the results queue (match finished,
 * tie won) are for the demo only, so they are deleted before the drain sends them.
 *
 *   npx tsx --env-file=.env.localdb scripts/demo/finish-umpire-demo.ts           # stand-in
 *   UMPIRE_DEMO_LIVE=yes npx tsx --env-file=<production env> scripts/demo/finish-umpire-demo.ts
 *   … scripts/demo/finish-umpire-demo.ts dc-umpire-demo                            # one event
 */
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { finalizeMatch, upsertSnapshotFromState } from "../../src/lib/ops";
import { getMatches, getTeams, getTournament } from "../../src/lib/data";
import { drawPlacement, finalPlacings, getTies, lockLineups, setLineup } from "../../src/lib/tennis/tieOps";
import type { Match, Tie, Tournament } from "../../src/lib/types";

const DEMO_SLUGS = ["dc-umpire-demo", "bjk-umpire-demo"] as const;
const DONE = new Set(["completed", "retired", "walkover", "cancelled"]);

const url = process.env.SUPABASE_URL ?? "";
const local = /localhost|127\.0\.0\.1/.test(url);
if (!local && process.env.UMPIRE_DEMO_LIVE !== "yes") {
  console.error("Not the stand-in: set UMPIRE_DEMO_LIVE=yes to finish the demo events on the live project.");
  process.exit(1);
}

/** Deterministic "who wins this point". */
let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** Plays a rubber point by point until `winner` has it (the loser takes some games). */
function playTo(t: Tournament, m: Match, winner: TeamKey, strength = 0.6): ScoreState[] {
  const cfg = scoringConfigForMatch(t, m, null, { doubles: m.rubber_type === "D" });
  const loser: TeamKey = winner === "A" ? "B" : "A";
  let s = initialScoreState("A");
  const trail = [s];
  let guard = 0;
  while (!s.matchOver) {
    s = awardPoint(s, rand() < strength ? winner : loser, cfg);
    trail.push(s);
    if (++guard > 2000) throw new Error("runaway rubber");
  }
  if (s.winner !== winner) return playTo(t, m, winner, Math.min(0.95, strength + 0.1));
  return trail;
}

/** Drops the demo's queued alerts before the scheduled drain sends them. */
async function dropAlerts(tid: string) {
  await db().from("notification_events").delete().eq("tournament_id", tid).is("sent_at", null);
}

async function nominate(tid: string, tie: Tie, rubbers: Match[], squads: Map<string, string[]>) {
  if (rubbers.every((r) => (r.team_a_player_ids?.length ?? 0) > 0 && (r.team_b_player_ids?.length ?? 0) > 0)) return;
  for (const side of ["A", "B"] as const) {
    const s = squads.get((side === "A" ? tie.team_a_id : tie.team_b_id)!)!;
    const named = (type: string) => {
      const r = rubbers.find((x) => x.rubber_type === type);
      const ids = side === "A" ? r?.team_a_player_ids : r?.team_b_player_ids;
      return ids?.length ? ids : null;
    };
    const lineup = { S1: named("S1")?.[0] ?? s[0], S2: named("S2")?.[0] ?? s[1], D: named("D") ?? [s[0], s[2]] };
    const opts: { accept: string[]; lateChangeReason?: string } = { accept: [] };
    let r = await setLineup(tid, tie.id, side, lineup, "demo", opts);
    // A warning (order of merit, a retired player) is accepted, a locked tie gets a reason.
    for (let i = 0; i < 3 && !r.ok; i++) {
      if (r.code === "warnings") opts.accept.push(...(r.warnings ?? []).map((w) => w.key));
      else if (r.code === "reason") opts.lateChangeReason = "Demo: named by the organiser";
      else break;
      r = await setLineup(tid, tie.id, side, lineup, "demo", opts);
    }
    if (!r.ok) throw new Error(`line-up ${tie.round_name} ${side}: ${r.message}`);
  }
  if (!tie.lineup_locked_at) await lockLineups(tid, tie.id, "demo");
}

/** Plays every tie that knows both nations. Returns how many rubbers it finished. */
async function playOpenTies(t: Tournament): Promise<number> {
  const teams = await getTeams(t.id);
  const squads = new Map(teams.map((x) => [x.id, [...(x.players ?? [])].sort((a, b) => a.player_order - b.player_order).map((p) => p.id)]));
  const seedOf = new Map(teams.map((x) => [x.id, x.seed_number ?? 99]));
  let finished = 0;
  for (const tie of await getTies(t.id)) {
    if (!tie.team_a_id || !tie.team_b_id || tie.status === "completed") continue;
    let rubbers = (await getMatches(t.id)).filter((m) => m.tie_id === tie.id);
    await nominate(t.id, tie, rubbers, squads);
    rubbers = (await getMatches(t.id)).filter((m) => m.tie_id === tie.id).sort((a, b) => (a.rubber_no ?? 0) - (b.rubber_no ?? 0));
    // The better-seeded nation usually wins; now and then the other one does.
    const fav: TeamKey = (seedOf.get(tie.team_a_id) ?? 99) <= (seedOf.get(tie.team_b_id) ?? 99) ? "A" : "B";
    for (const m of rubbers) {
      if (DONE.has(m.status)) continue;
      const winner: TeamKey = rand() < 0.7 ? fav : fav === "A" ? "B" : "A";
      const trail = playTo(t, m, winner);
      const { data: snap } = await db().from("match_score_snapshots").select("last_event_number").eq("match_id", m.id).maybeSingle();
      const base = (snap as { last_event_number: number } | null)?.last_event_number ?? 0;
      await upsertSnapshotFromState(m, trail[trail.length - 1], base + trail.length);
      await finalizeMatch(m, { status: "completed", winnerTeamId: winner === "A" ? m.team_a_id! : m.team_b_id!, actorRole: "demo" });
      finished++;
    }
    await dropAlerts(t.id);
    console.log(`   ${tie.round_name}: done`);
  }
  return finished;
}

async function finish(slug: string) {
  const { data } = await db().from("tournaments").select("id").eq("slug", slug).maybeSingle();
  if (!data) {
    console.log(`${slug}: not on this database, skipped`);
    return;
  }
  const tid = (data as { id: string }).id;
  console.log(`\n${slug}`);
  for (let pass = 0; pass < 8; pass++) {
    const t = (await getTournament(tid))!;
    const played = await playOpenTies(t);
    const ties = await getTies(tid);
    if (!ties.some((x) => x.stage === "placement") && ties.filter((x) => x.stage === "group").every((x) => x.status === "completed")) {
      const drawn = await drawPlacement(tid, "demo");
      console.log(drawn.ok ? `   placement draws made: ${drawn.ties} ties` : `   placement draws refused: ${drawn.message}`);
      if (!drawn.ok) break;
      continue;
    }
    if (!played) break;
  }
  await dropAlerts(tid);
  const places = await finalPlacings(tid);
  const names = new Map((await getTeams(tid)).map((x) => [x.id, x.team_name]));
  console.log(`   ${places.length} of 16 places decided`);
  for (const p of places.slice(0, 4)) console.log(`   ${p.place}. ${names.get(p.team_id)}`);
}

async function main() {
  const only = process.argv[2];
  const slugs = only ? DEMO_SLUGS.filter((s) => s === only) : DEMO_SLUGS;
  if (only && !slugs.length) throw new Error(`Only the demo events: ${DEMO_SLUGS.join(", ")}`);
  for (const slug of slugs) await finish(slug);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
