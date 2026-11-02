/**
 * Gate for the Smash importer (src/lib/smash/, route /api/internal/smash/import) — LOCAL STAND-IN ONLY.
 *
 * Seeds the two Cairo event slugs on the stand-in from the recorded Smash day (one tie per court, the
 * line-ups as Smash played them), serves that recording from a fake Smash feed, then calls the
 * route as the cron does: two overlapping calls (one is busy), then runs until nothing is left, then
 * once more. Checks: each clean result entered once (RESULT_ENTERED, final_score, audited "Smash
 * import"), ties and standings updated, courts 13/14 and already-scored rubbers untouched, the
 * doubtful ones listed for the desk. Deletes what it made.
 *
 *   LOCALDB_PORT=54390 node scripts/localdb/server.mjs &
 *   SUPABASE_URL=http://localhost:54390 SMASH_IMPORT_ON=1 SMASH_FEED_URL=http://localhost:54391 npx next start -p 3090 &
 *   SUPABASE_URL=http://localhost:54390 BASE_URL=http://localhost:3090 SMASH_FAKE_PORT=54391 \
 *     npx tsx --env-file=.env.localdb scripts/e2e/smash-import.ts
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { db } from "../../src/lib/supabase";
import { enterFinalResult } from "../../src/lib/scoring/append";
import { recalcTieStandings } from "../../src/lib/tennis/tieOps";
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

const recording = JSON.parse(readFileSync(join(__dirname, "../../src/lib/smash/fixtures/2026-11-02-end-of-day.json"), "utf8")) as { schedule: unknown };
const smash = parseSmashSchedule(recording);
const BJK_COURTS = new Set([1, 2, 3, 4, 5, 6, 14, 16]);

async function call(secret = process.env.CRON_SECRET ?? ""): Promise<{ status: number; body: SmashImportSummary & { off?: boolean } }> {
  const res = await fetch(`${BASE_URL}/api/internal/smash/import`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: "{}" });
  return { status: res.status, body: (await res.json()) as SmashImportSummary };
}

async function seed() {
  const ids: Record<string, string> = {};
  const rubber: Record<string, string> = {}; // "court-type" → match id
  for (const slug of SMASH_EVENT_SLUGS) {
    await db().from("tournaments").delete().eq("slug", slug);
    const { data, error } = await db()
      .from("tournaments")
      .insert({
        name: `E2E Smash ${slug}`,
        slug,
        sport: "tennis",
        status: "active",
        is_demo: true,
        scoring_config: DEFAULT_TENNIS_SCORING_CONFIG,
        format_config: { type: "group_knockout", qualifyPerGroup: 2, thirdPlaceMatch: false, ties: {} },
        match_day_rules: newTournamentMatchDayRules("tennis"),
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "no tournament");
    ids[slug.startsWith("bjk") ? "bjk" : "dc"] = (data as { id: string }).id;
  }
  const courts = [...new Set(smash.matches.map((m) => m.court))];
  for (const court of courts) {
    const tid = ids[BJK_COURTS.has(court) ? "bjk" : "dc"];
    const ms = smash.matches.filter((m) => m.court === court);
    const { data: c } = await db().from("courts").insert({ tournament_id: tid, court_name: `Court ${court}`, court_order: court }).select("id").single();
    const { data: g } = await db().from("groups").insert({ tournament_id: tid, group_name: `Group C${court}`, group_order: court, status: "published" }).select("id").single();
    const teamIds: string[] = [];
    const playerIds = new Map<string, string>();
    for (const [i, side] of ms[0].sides.entries()) {
      const { data: t } = await db().from("teams").insert({ tournament_id: tid, team_name: side.code, nation_code: side.code, check_in_status: "checked_in" }).select("id").single();
      const teamId = (t as { id: string }).id;
      teamIds.push(teamId);
      const names = [...new Set(ms.flatMap((m) => m.sides[i].names))];
      const { data: ps } = await db()
        .from("players")
        .insert(names.map((full_name, j) => ({ tournament_id: tid, team_id: teamId, player_order: j + 1, full_name })))
        .select("id, full_name");
      for (const p of (ps ?? []) as { id: string; full_name: string }[]) playerIds.set(`${i}:${p.full_name}`, p.id);
    }
    await db().from("group_teams").insert(teamIds.map((team_id, i) => ({ tournament_id: tid, group_id: (g as { id: string }).id, team_id, position: i + 1 })));
    const { data: tie } = await db()
      .from("ties")
      .insert({ tournament_id: tid, stage: "group", group_id: (g as { id: string }).id, round_no: 1, round_name: `Group C${court}`, tie_order: court, court_id: (c as { id: string }).id, scheduled_time: "2026-11-02T07:30:00Z", team_a_id: teamIds[0], team_b_id: teamIds[1] })
      .select("id")
      .single();
    let singles = 0;
    for (const [i, m] of ms.entries()) {
      const type = m.type === "doubles" ? "D" : singles++ === 0 ? "S2" : "S1";
      const { data: r, error } = await db()
        .from("matches")
        .insert({
          tournament_id: tid,
          tie_id: (tie as { id: string }).id,
          rubber_no: i + 1,
          rubber_type: type,
          stage: "group",
          group_id: (g as { id: string }).id,
          round_name: `Group C${court} · ${type}`,
          match_order: court * 10 + i,
          court_id: (c as { id: string }).id,
          scheduled_time: "2026-11-02T07:30:00Z",
          team_a_id: teamIds[0],
          team_b_id: teamIds[1],
          status: "scheduled",
          team_a_player_ids: m.sides[0].names.map((n) => playerIds.get(`0:${n}`)),
          team_b_player_ids: m.sides[1].names.map((n) => playerIds.get(`1:${n}`)),
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      rubber[`${court}-${type}`] = (r as { id: string }).id;
    }
  }
  for (const tid of Object.values(ids)) await recalcTieStandings(tid);
  return { ids, rubber };
}

async function events(matchId: string) {
  const { data } = await db().from("score_events").select("event_type, created_by_role, note").eq("match_id", matchId);
  return (data ?? []) as { event_type: string; created_by_role: string | null; note: string | null }[];
}

async function main() {
  const fake = createServer((req, res) => {
    if (req.url?.startsWith("/api/public/schedule")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recording.schedule));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => fake.listen(FAKE_PORT, r));
  let ids: Record<string, string> = {};
  try {
    const seeded = await seed();
    ids = seeded.ids;
    const R = seeded.rubber;

    // Already on Move Score before the import: an organiser's result, a live rubber, a line-up that differs, one not named.
    const own = await enterFinalResult({ matchId: R["2-S2"], payload: { sets: [{ a: 4, b: 6 }, { a: 4, b: 6 }] }, role: "admin", actor: "e2e" });
    check("seed: the organiser entered court 2's S2 by hand first (TUN 6-4 6-4)", own.ok, own.ok ? "" : own.error);
    await db().from("matches").update({ status: "live" }).eq("id", R["3-S2"]);
    await db().from("match_score_snapshots").upsert({ match_id: R["3-S2"], tournament_id: ids.bjk, last_event_number: 1, team_a_point_label: "15" }, { onConflict: "match_id" });
    const { data: d6 } = await db().from("matches").select("team_a_player_ids").eq("id", R["6-D"]).single();
    await db().from("matches").update({ team_a_player_ids: [(d6 as { team_a_player_ids: string[] }).team_a_player_ids[0], (d6 as { team_a_player_ids: string[] }).team_a_player_ids[0]] }).eq("id", R["6-D"]);
    await db().from("matches").update({ team_a_player_ids: null, team_b_player_ids: null }).eq("id", R["4-S1"]);

    const refused = await call("wrong");
    check("a call without the cron secret is refused", refused.status === 401, String(refused.status));

    // Two overlapping runs: one enters, the other is busy.
    const [x, y] = await Promise.all([call(), call()]);
    check("both overlapping calls answer 200", x.status === 200 && y.status === 200, `${x.status} ${y.status}`);
    const busy = [x, y].filter((r) => r.body.busy).length;
    check("…exactly one of them is busy (run lock)", busy === 1, JSON.stringify([x.body.busy, y.body.busy]));
    const first = x.body.busy ? y.body : x.body;
    check("the first run enters at most 6", first.entered.length === 6, String(first.entered.length));
    check("…and says how many wait for the next run", first.waiting === 26, String(first.waiting));

    const all = [...first.entered];
    let last = first;
    for (let i = 0; i < 10 && (last.waiting > 0 || last.entered.length > 0); i++) {
      last = (await call()).body;
      all.push(...last.entered);
    }
    const again = await call();
    check("a run after everything is in enters nothing", again.status === 200 && again.body.entered.length === 0 && again.body.waiting === 0, JSON.stringify(again.body).slice(0, 200));
    check("32 results entered in all, each once", all.length === 32 && new Set(all.map((e) => `${e.court}${e.ours}`)).size === 32, String(all.length));
    check("none on court 13 or 14", !all.some((e) => e.court === 13 || e.court === 14));

    const desk = again.body.desk.map((d) => `${d.court} ${d.why}`);
    for (const [court, re] of [
      [1, /no tie-break points/],
      [8, /no tie-break points/],
      [15, /no tie-break points/],
      [16, /no tie-break points/],
      [6, /doubles pair differs/],
      [4, /no singles rubber/],
    ] as const) {
      check(`desk lists court ${court} (${re.source})`, desk.some((d) => d.startsWith(`${court} `) && re.test(d)), desk.filter((d) => d.startsWith(`${court} `)).join(" | "));
    }
    check("skipped lists courts 13/14 and the rubbers already on Move Score", again.body.skippedList.filter((s) => /court scored on Move Score/.test(s)).length === 6 && again.body.skippedList.some((s) => /Court 2 .*S2: already completed/.test(s)) && again.body.skippedList.some((s) => /Court 3 .*S2: already live/.test(s)), again.body.skippedList.join(" | "));

    // Each entered rubber: one RESULT_ENTERED by "system", finished, final_score.
    const enteredIds = Object.entries(R).filter(([k]) => all.some((e) => `${e.court}-${e.ours?.split(" ").pop()}` === k)).map(([, v]) => v);
    check("32 rubbers resolved from the run summaries", enteredIds.length === 32, String(enteredIds.length));
    const { data: done } = await db().from("matches").select("id, status, result_source, winner_team_id").in("id", enteredIds);
    const doneRows = (done ?? []) as { id: string; status: string; result_source: string | null }[];
    check("every entered rubber is completed with result_source final_score", doneRows.length === 32 && doneRows.every((m) => m.status === "completed" && m.result_source === "final_score"), JSON.stringify(doneRows.filter((m) => m.status !== "completed" || m.result_source !== "final_score")).slice(0, 300));
    const evs = await Promise.all(enteredIds.map(events));
    check("…each with exactly one score event, a RESULT_ENTERED by system", evs.every((e) => e.length === 1 && e[0].event_type === "RESULT_ENTERED" && e[0].created_by_role === "system"));
    const { data: audits } = await db().from("audit_logs").select("actor_name, actor_role, entity_id").eq("action", "SMASH_RESULT_IMPORTED").in("entity_id", enteredIds);
    const auditRows = (audits ?? []) as { actor_name: string | null; actor_role: string | null }[];
    check("each entered result is audited as \"Smash import\" (system)", auditRows.length === 32 && auditRows.every((a) => a.actor_name === "Smash import" && a.actor_role === "system"), String(auditRows.length));

    // Court 7 S2: 4-6 6-4 6-7(4), Hungary.
    const c7 = await events(R["7-S2"]);
    check("court 7 S2 entered as Smash wrote it, tie-break points included", JSON.parse(c7[0]?.note ?? "{}").sets?.[2]?.tb?.b === 7, c7[0]?.note ?? "");
    const c7d = await events(R["7-D"]);
    check("court 7 doubles: the match tie-break [8-10] entered as one", JSON.stringify(JSON.parse(c7d[0]?.note ?? "{}").sets?.[2]) === JSON.stringify({ a: 0, b: 1, tb: { a: 8, b: 10 } }), c7d[0]?.note ?? "");

    // Untouched.
    for (const k of ["13-S2", "13-S1", "13-D", "14-S2", "14-S1", "14-D"]) {
      const { data: m } = await db().from("matches").select("status").eq("id", R[k]).single();
      const e = await events(R[k]);
      check(`court ${k} untouched (scheduled, no events)`, (m as { status: string }).status === "scheduled" && e.length === 0);
    }
    const c2 = await events(R["2-S2"]);
    check("court 2 S2 keeps the organiser's own result only", c2.length === 1 && c2[0].created_by_role === "admin" && JSON.parse(c2[0].note ?? "{}").sets?.[0]?.a === 4, JSON.stringify(c2));
    const { data: c3 } = await db().from("matches").select("status").eq("id", R["3-S2"]).single();
    check("court 3 S2 (live on Move Score) untouched", (c3 as { status: string }).status === "live" && (await events(R["3-S2"])).length === 0);
    for (const k of ["1-D", "15-S2", "16-S1", "6-D", "4-S1"]) {
      check(`desk rubber ${k} not entered`, (await events(R[k])).length === 0);
    }

    // Ties and standings: court 9 (JPN won all three) and court 7 (HUN 2-1).
    const { data: ties } = await db().from("ties").select("court_id, status, rubbers_a, rubbers_b, winner_team_id, team_a_id, team_b_id, round_name").in("tournament_id", Object.values(ids));
    const tie = (n: number) => ((ties ?? []) as { round_name: string; status: string; rubbers_a: number; rubbers_b: number; winner_team_id: string | null; team_a_id: string; team_b_id: string }[]).find((t) => t.round_name === `Group C${n}`)!;
    check("court 9 tie: JPN 3-0, completed", tie(9).status === "completed" && tie(9).rubbers_a === 3 && tie(9).rubbers_b === 0 && tie(9).winner_team_id === tie(9).team_a_id, JSON.stringify(tie(9)));
    check("court 7 tie: HUN 2-1, completed", tie(7).status === "completed" && tie(7).rubbers_a === 1 && tie(7).rubbers_b === 2 && tie(7).winner_team_id === tie(7).team_b_id, JSON.stringify(tie(7)));
    check("court 13 tie still scheduled", tie(13).status === "scheduled" && tie(13).rubbers_a === 0 && tie(13).rubbers_b === 0, JSON.stringify(tie(13)));
    const { data: st } = await db().from("standings_snapshots").select("team_id, rubbers_won, rubbers_lost").eq("tournament_id", ids.dc);
    const jpn = ((st ?? []) as { team_id: string; rubbers_won: number; rubbers_lost: number }[]).find((s) => s.team_id === tie(9).team_a_id);
    check("standings: JPN 3 rubbers won, 0 lost", jpn?.rubbers_won === 3 && jpn?.rubbers_lost === 0, JSON.stringify(jpn));
  } catch (e) {
    check("the run finished", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    fake.close();
    for (const slug of SMASH_EVENT_SLUGS) await db().from("tournaments").delete().eq("slug", slug);
    const { count } = await db().from("ties").select("id", { count: "exact", head: true }).in("tournament_id", Object.values(ids).length ? Object.values(ids) : ["00000000-0000-0000-0000-000000000000"]);
    check("cleanup removed everything", (count ?? 0) === 0);
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
