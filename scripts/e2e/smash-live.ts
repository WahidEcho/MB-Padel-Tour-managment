/**
 * Gate for the Smash live mirror (src/lib/smash/, route /api/internal/smash/import) — LOCAL STAND-IN ONLY.
 *
 * Seeds the 3 Nov 2026 morning ties of the two Cairo event slugs from the recorded Smash feeds (one tie
 * per court, line-ups as Smash had them, singles #1 in play), serves the recording (schedule + live)
 * from a fake Smash, then calls the route as the cron does. Checks: every singles in play off courts
 * 13/14 shows Smash's live score (sets, games, points, server) with no score event and the rubber
 * live; a second run with nothing new writes nothing; courts 13/14 and a referee's live rubber are
 * untouched; when Smash finishes a match the result is entered over the mirror. Deletes what it made.
 *
 *   LOCALDB_PORT=54390 node scripts/localdb/server.mjs &
 *   SUPABASE_URL=http://localhost:54390 SMASH_IMPORT_ON=1 SMASH_FEED_URL=http://localhost:54391 npx next start -p 3090 &
 *   SUPABASE_URL=http://localhost:54390 BASE_URL=http://localhost:3090 SMASH_FAKE_PORT=54391 \
 *     npx tsx --env-file=.env.localdb scripts/e2e/smash-live.ts
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { db } from "../../src/lib/supabase";
import { newTournamentMatchDayRules } from "../../src/lib/matchday/rules";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../../src/lib/types";
import { parseSmashSchedule } from "../../src/lib/smash/feed";
import { SMASH_EVENT_SLUGS } from "../../src/lib/smash/plan";
import type { SmashImportSummary } from "../../src/lib/smash/server";

const BASE_URL = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const local = (u: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u);
if (!local(BASE_URL) || !local(SUPABASE_URL)) {
  console.error("Refusing: BASE_URL and SUPABASE_URL must both be a local stand-in (http://localhost:…).");
  process.exit(2);
}
const FAKE_PORT = Number(process.env.SMASH_FAKE_PORT ?? 0);
if (!FAKE_PORT) throw new Error("SMASH_FAKE_PORT (the port the server's SMASH_FEED_URL points at) is required");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const dir = join(__dirname, "../../src/lib/smash/fixtures");
const scheduleRaw = JSON.parse(readFileSync(join(dir, "2026-11-03-morning-schedule.json"), "utf8")) as { courts: { courtNumber: number; matches: Record<string, unknown>[] }[] };
let liveRaw = JSON.parse(readFileSync(join(dir, "2026-11-03-morning-live.json"), "utf8")) as Record<string, unknown>[];
let served: unknown = scheduleRaw;
const DAY = "2026-11-03";
const today = parseSmashSchedule(scheduleRaw).matches.filter((m) => m.day === DAY);
const BJK_COURTS = new Set([1, 2, 3, 4, 5, 6, 14, 16]);

async function call(): Promise<SmashImportSummary> {
  const res = await fetch(`${BASE_URL}/api/internal/smash/import`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`, "Content-Type": "application/json" }, body: "{}" });
  return (await res.json()) as SmashImportSummary;
}

async function seed() {
  const ids: Record<string, string> = {};
  const rubber: Record<string, string> = {};
  for (const slug of SMASH_EVENT_SLUGS) {
    await db().from("tournaments").delete().eq("slug", slug);
    const { data, error } = await db()
      .from("tournaments")
      .insert({ name: `E2E Smash live ${slug}`, slug, sport: "tennis", status: "active", is_demo: true, scoring_config: DEFAULT_TENNIS_SCORING_CONFIG, format_config: { type: "group_knockout", qualifyPerGroup: 2, thirdPlaceMatch: false, ties: {} }, match_day_rules: newTournamentMatchDayRules("tennis") })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "no tournament");
    ids[slug.startsWith("bjk") ? "bjk" : "dc"] = (data as { id: string }).id;
  }
  for (const m of today) {
    const tid = ids[BJK_COURTS.has(m.court) ? "bjk" : "dc"];
    const { data: c } = await db().from("courts").insert({ tournament_id: tid, court_name: `Court ${m.court}`, court_order: m.court }).select("id").single();
    const teamIds: string[] = [];
    const playerIds: string[][] = [];
    for (const side of m.sides) {
      const { data: t } = await db().from("teams").insert({ tournament_id: tid, team_name: side.code, nation_code: side.code, check_in_status: "checked_in" }).select("id").single();
      teamIds.push((t as { id: string }).id);
      const { data: ps } = await db().from("players").insert(side.names.map((full_name, j) => ({ tournament_id: tid, team_id: (t as { id: string }).id, player_order: j + 1, full_name }))).select("id");
      playerIds.push(((ps ?? []) as { id: string }[]).map((p) => p.id));
    }
    const { data: tie } = await db()
      .from("ties")
      .insert({ tournament_id: tid, stage: "group", round_no: 2, round_name: `Day 2 C${m.court}`, tie_order: m.court, court_id: (c as { id: string }).id, scheduled_time: `${DAY}T07:30:00Z`, team_a_id: teamIds[0], team_b_id: teamIds[1] })
      .select("id")
      .single();
    const { data: r, error } = await db()
      .from("matches")
      .insert({ tournament_id: tid, tie_id: (tie as { id: string }).id, rubber_no: 1, rubber_type: "S2", stage: "group", round_name: `Day 2 C${m.court} · S2`, match_order: m.court, court_id: (c as { id: string }).id, scheduled_time: `${DAY}T07:30:00Z`, team_a_id: teamIds[0], team_b_id: teamIds[1], status: "scheduled", team_a_player_ids: playerIds[0], team_b_player_ids: playerIds[1] })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    rubber[`C${m.court}`] = (r as { id: string }).id;
  }
  return { ids, rubber };
}

async function main() {
  const fake = createServer((req, res) => {
    const body = req.url?.startsWith("/api/public/schedule") ? served : req.url?.startsWith("/api/public/live") ? liveRaw : null;
    if (body === null) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => fake.listen(FAKE_PORT, r));
  let ids: Record<string, string> = {};
  try {
    const seeded = await seed();
    ids = seeded.ids;
    const R = seeded.rubber;
    check("seed: one tie per court in play this morning", Object.keys(R).length === today.length, String(today.length));

    // A referee already has court 16 on Move Score (one point scored).
    await db().from("matches").update({ status: "live" }).eq("id", R.C16);
    await db().from("match_score_snapshots").upsert({ match_id: R.C16, tournament_id: ids.bjk, last_event_number: 1, team_a_point_label: "15" }, { onConflict: "match_id" });

    const first = await call();
    check("the run answers with the live part", Array.isArray(first.live?.updated), JSON.stringify(first).slice(0, 300));
    const courts = first.live.updated.map((u) => u.court).sort((a, b) => a - b);
    check("Smash's live score written on 11 courts (all in play but 13, 14 and the referee's 16)", courts.length === 11 && !courts.some((c) => [13, 14, 16].includes(c)), courts.join(","));

    const { data: c15 } = await db().from("matches").select("status, started_at").eq("id", R.C15).single();
    const { data: s15 } = await db().from("match_score_snapshots").select("team_a_games, team_b_games, team_a_point_label, team_b_point_label, last_event_number, snapshot_json").eq("match_id", R.C15).single();
    const snap = s15 as { team_a_games: number; team_b_games: number; team_a_point_label: string; team_b_point_label: string; last_event_number: number; snapshot_json: { source?: string; servingTeam?: string } };
    check("court 15 (ITA v JPN): live, 1-2 15-40, Italy serving, marked as Smash's", (c15 as { status: string }).status === "live" && snap.team_a_games === 1 && snap.team_b_games === 2 && snap.team_a_point_label === "15" && snap.team_b_point_label === "40" && snap.snapshot_json.source === "smash" && snap.snapshot_json.servingTeam === "A", JSON.stringify(snap));
    check("…with no score event and last event 0", snap.last_event_number === 0 && ((await db().from("score_events").select("id").eq("match_id", R.C15)).data ?? []).length === 0);

    for (const k of ["C13", "C14"]) {
      const { data: m } = await db().from("matches").select("status").eq("id", R[k]).single();
      const { data: sn } = await db().from("match_score_snapshots").select("match_id").eq("match_id", R[k]);
      check(`${k} untouched (scheduled, no snapshot)`, (m as { status: string }).status === "scheduled" && (sn ?? []).length === 0);
    }
    const { data: s16 } = await db().from("match_score_snapshots").select("team_a_point_label, last_event_number").eq("match_id", R.C16).single();
    check("court 16 (a referee's) keeps its own score", (s16 as { team_a_point_label: string; last_event_number: number }).last_event_number === 1 && (s16 as { team_a_point_label: string }).team_a_point_label === "15");

    const second = await call();
    check("a second run with the same feed rewrites nothing", second.live.updated.length === 0 && second.live.unchanged === 11, JSON.stringify(second.live).slice(0, 200));

    // Smash moves on: court 15 goes to 2-2 30-0.
    liveRaw = liveRaw.map((m) => (m.courtNumber === 15 && m.status === "live" ? { ...m, score: { ...(m.score as object), sets: [[2, 2]], gameScore: { p1: "30", p2: "0" } } } : m));
    const third = await call();
    const s15b = (await db().from("match_score_snapshots").select("team_a_games, team_b_games, team_a_point_label").eq("match_id", R.C15).single()).data as { team_a_games: number; team_b_games: number; team_a_point_label: string };
    check("the next point reaches us: court 15 now 2-2 30-0 (only that court rewritten)", third.live.updated.length === 1 && s15b.team_a_games === 2 && s15b.team_b_games === 2 && s15b.team_a_point_label === "30", JSON.stringify(third.live.updated));

    // Smash finishes court 15: ITA 6-2 6-3.
    const c15id = today.find((m) => m.court === 15)!.id;
    served = { ...scheduleRaw, courts: scheduleRaw.courts.map((c) => ({ ...c, matches: c.matches.map((m) => (m.id === c15id ? { ...m, status: "completed", winner_player: 1, completed_at: Math.floor(Date.parse(`${DAY}T09:30:00Z`) / 1000), score: { sets: [[6, 2], [6, 3]], setTiebreaks: [null, null], winner: 1 } } : m)) })) };
    liveRaw = liveRaw.filter((m) => m.matchId !== c15id);
    const fourth = await call();
    check("the finished result is entered over the mirrored live score", fourth.entered.some((e) => e.court === 15), JSON.stringify({ entered: fourth.entered, desk: fourth.desk }).slice(0, 400));
    const { data: done } = await db().from("matches").select("status, result_source").eq("id", R.C15).single();
    const evs = ((await db().from("score_events").select("event_type, created_by_role").eq("match_id", R.C15)).data ?? []) as { event_type: string; created_by_role: string }[];
    check("court 15 completed from the final score, one RESULT_ENTERED by system", (done as { status: string }).status === "completed" && (done as { result_source: string }).result_source === "final_score" && evs.length === 1 && evs[0].event_type === "RESULT_ENTERED" && evs[0].created_by_role === "system", JSON.stringify({ done, evs }));
  } catch (e) {
    check("the run finished", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    fake.close();
    for (const slug of SMASH_EVENT_SLUGS) await db().from("tournaments").delete().eq("slug", slug);
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
