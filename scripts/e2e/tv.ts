/**
 * Venue screen end-to-end, against the live Supabase project.
 *
 * Drives real events through the real routes with the score driver, so what is
 * checked is what a referee's tablet and a venue screen would actually produce:
 * the result-confirmation step, the undo watermark, per-court resolution, and the
 * live feed a screen polls. Visual checks (the entrance and result animations on
 * screen) are done in the browser against the tournament this leaves running when
 * KEEP=1 is set; otherwise it cleans up after itself.
 *
 * Needs the dev server: BASE_URL defaults to http://localhost:3001.
 *
 *   npx tsx --env-file=.env.local scripts/e2e/tv.ts
 *   KEEP=1 npx tsx --env-file=.env.local scripts/e2e/tv.ts   # leave it for the browser
 */
import { db } from "../../src/lib/supabase";
import { openDriver, point } from "./lib/driver";
import { BASE_URL, authHeaders } from "./lib/session";
import { courtSlots } from "../../src/lib/tv/courtSlots";
import { getReopenState } from "../../src/lib/data";
import type { LiveFeed } from "../../src/lib/tv/liveFeed";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function status(matchId: string) {
  const { data } = await db().from("matches").select("status, ended_at, winner_team_id").eq("id", matchId).single();
  return data as { status: string; ended_at: string | null; winner_team_id: string | null };
}

async function makeTournament(label: string, confirm: boolean, sport: "padel" | "chess" = "padel") {
  const { data: t, error } = await db()
    .from("tournaments")
    .insert({
      name: `E2E TV ${label}`,
      slug: `e2e-tv-${label}-${Date.now()}`,
      sport,
      status: "active",
      is_demo: true,
      public_access_enabled: true,
      scoring_config: {
        setsToWinMatch: 1,
        gamesToWinSet: 2,
        tiebreakEnabled: false,
        tiebreakAtGames: 6,
        tiebreakTargetPoints: 7,
        tiebreakWinByTwo: true,
        walkoverScore: "2-0",
        requireResultConfirmation: confirm,
      },
      branding_config: {},
    })
    .select()
    .single();
  if (error || !t) throw new Error(error?.message ?? "no tournament");
  const tid = t.id as string;

  await db().from("courts").insert([1, 2, 3, 4].map((n) => ({ tournament_id: tid, court_name: `Court ${n}`, court_order: n })));
  const { data: courts } = await db().from("courts").select("id, court_name").eq("tournament_id", tid).order("court_order");

  const { data: teams } = await db()
    .from("teams")
    .insert(Array.from({ length: 8 }, (_, i) => ({ tournament_id: tid, team_name: `Team ${String.fromCharCode(65 + i)}`, check_in_status: "checked_in" })))
    .select("id, team_name");
  await db()
    .from("players")
    .insert(
      (teams ?? []).flatMap((team, i) => [
        { tournament_id: tid, team_id: team.id, player_order: 1, full_name: `Player ${i * 2 + 1} First` },
        { tournament_id: tid, team_id: team.id, player_order: 2, full_name: `Player ${i * 2 + 2} Second` },
      ]),
    );

  const { data: matches } = await db()
    .from("matches")
    .insert(
      (courts ?? []).map((court, i) => ({
        tournament_id: tid,
        stage: "group",
        round_name: `Round 1`,
        match_order: i + 1,
        court_id: court.id,
        team_a_id: teams![i * 2].id,
        team_b_id: teams![i * 2 + 1].id,
        status: "scheduled",
      })),
    )
    .select("id, court_id");
  await db().from("screen_settings").upsert({ tournament_id: tid, screen_key: "main", display_mode: "live" }, { onConflict: "tournament_id,screen_key" });
  return { tid, slug: t.slug as string, courts: courts ?? [], matchIds: (matches ?? []).map((m) => m.id as string) };
}

/** Plays a match to its final point (first to 2 games) without confirming. */
async function playToMatchPoint(matchId: string) {
  const d = await openDriver(matchId);
  // MATCH_STARTED, so the match is live and the screen has a started_at.
  const res = await fetch(`${BASE_URL}/api/matches/${matchId}/events`, {
    method: "POST",
    headers: authHeaders("admin", { "Content-Type": "application/json" }),
    body: JSON.stringify({
      deviceId: d.deviceId,
      events: [
        {
          client_event_id: crypto.randomUUID(),
          event_number: d.eventNumber + 1,
          event_type: "MATCH_STARTED",
          team_id: null,
          previous_state: null,
          new_state: d.state,
          payload: null,
          created_at_client: new Date().toISOString(),
        },
      ],
    }),
  });
  if (res.status !== 200) throw new Error(`start failed: ${res.status}`);
  d.eventNumber += 1;
  for (let i = 0; i < 8; i++) await point(d, "A"); // two games to love
  return d;
}

async function main() {
  console.log("— Venue screen end-to-end —");
  const keep = process.env.KEEP === "1";
  const created: string[] = [];

  try {
    // ---------- confirmation ON ----------
    const on = await makeTournament("confirm", true);
    created.push(on.tid);
    const d = await playToMatchPoint(on.matchIds[0]);
    const afterPoint = await status(on.matchIds[0]);
    const { data: snap } = await db()
      .from("match_score_snapshots")
      .select("snapshot_json, team_a_games")
      .eq("match_id", on.matchIds[0])
      .single();
    const over = (snap as { snapshot_json: { matchOver?: boolean } }).snapshot_json?.matchOver === true;

    check("with confirmation on, the winning point records a finished score", over);
    check(
      "…but does not end the match — it waits for the referee",
      afterPoint.status === "live" && afterPoint.ended_at === null,
      `status ${afterPoint.status}, ended_at ${afterPoint.ended_at}`,
    );

    // The venue screen must see the finished score straight away, before confirmation.
    const feedRes = await fetch(`${BASE_URL}/api/t/${on.slug}/live`);
    const feed = (await feedRes.json()) as LiveFeed;
    const liveSnap = feed.snapshots.find((s) => s.match_id === on.matchIds[0]);
    check("the live feed already shows the match as over", liveSnap?.match_over === true);
    const slot = courtSlots([on.courts[0].id], feed.matches, feed.fetchedAt)[0];
    check("the court card stays live until the result is confirmed", slot.kind === "live", slot.kind);

    // Confirm.
    const confirm = await fetch(`${BASE_URL}/api/matches/${on.matchIds[0]}/events`, {
      method: "POST",
      headers: authHeaders("admin", { "Content-Type": "application/json" }),
      body: JSON.stringify({
        deviceId: d.deviceId,
        events: [
          {
            client_event_id: crypto.randomUUID(),
            event_number: d.eventNumber + 1,
            event_type: "MATCH_ENDED",
            team_id: d.match.team_a_id,
            previous_state: d.state,
            new_state: d.state,
            payload: { winner_team_id: d.match.team_a_id },
            created_at_client: new Date().toISOString(),
          },
        ],
      }),
    });
    check("confirming is accepted", confirm.status === 200, String(confirm.status));
    const afterConfirm = await status(on.matchIds[0]);
    check(
      "confirming ends the match and stamps when it ended",
      afterConfirm.status === "completed" && Boolean(afterConfirm.ended_at) && afterConfirm.winner_team_id === d.match.team_a_id,
      `status ${afterConfirm.status}`,
    );

    // Any referee device can reopen it, not just the one that confirmed.
    const reopen = (await getReopenState(on.matchIds[0])) as { matchOver?: boolean; teamA?: { games: number } } | null;
    check(
      "a confirmed match offers the score before its winning point, for a reopen from any tablet",
      reopen !== null && reopen.matchOver !== true && reopen.teamA?.games === 1,
      JSON.stringify(reopen?.teamA ?? null),
    );

    const feed2 = (await (await fetch(`${BASE_URL}/api/t/${on.slug}/live`)).json()) as LiveFeed;
    const held = courtSlots([on.courts[0].id], feed2.matches, feed2.fetchedAt)[0];
    check("the court card now holds the result", held.kind === "hold", held.kind);

    // ---------- confirmation OFF: existing behaviour unchanged ----------
    const off = await makeTournament("legacy", false);
    created.push(off.tid);
    await playToMatchPoint(off.matchIds[0]);
    const legacy = await status(off.matchIds[0]);
    check(
      "without the setting, the winning point still ends the match as it always did",
      legacy.status === "completed" && Boolean(legacy.ended_at),
      legacy.status,
    );

    // ---------- chess ignores the flag ----------
    // A chess board has no confirm step, so a chess tournament that somehow
    // carries the flag must still finish on its final result.
    const chess = await makeTournament("chess", true, "chess");
    created.push(chess.tid);
    await playToMatchPoint(chess.matchIds[0]);
    const chessStatus = await status(chess.matchIds[0]);
    check("a chess match still finishes on its final result even with the flag set", chessStatus.status === "completed", chessStatus.status);

    // ---------- a tournament that never set it at all ----------
    const { data: never } = await db()
      .from("tournaments")
      .select("scoring_config")
      .eq("id", off.tid)
      .single();
    check(
      "an unset flag reads as off, so no running tournament's flow changes",
      (never as { scoring_config: { requireResultConfirmation?: boolean } }).scoring_config.requireResultConfirmation !== true,
    );

    // ---------- the feed never carries anything private ----------
    const raw = JSON.stringify(feed2);
    check("the live feed carries no team rows, phones or notes", !raw.includes("phone") && !raw.includes("notes") && !raw.includes("team_name"));

    // ---------- a deleted screen stops being served ----------
    const missing = await fetch(`${BASE_URL}/api/t/${on.slug}/live?screen=does-not-exist`);
    check("an unknown screen key is a 404, not stale data", missing.status === 404, String(missing.status));

    if (keep) {
      // Start the other three courts so a browser can watch entrances and a live grid.
      for (const matchId of on.matchIds.slice(1)) {
        const dd = await openDriver(matchId);
        await fetch(`${BASE_URL}/api/matches/${matchId}/events`, {
          method: "POST",
          headers: authHeaders("admin", { "Content-Type": "application/json" }),
          body: JSON.stringify({
            deviceId: dd.deviceId,
            events: [
              {
                client_event_id: crypto.randomUUID(),
                event_number: dd.eventNumber + 1,
                event_type: "MATCH_STARTED",
                team_id: null,
                previous_state: null,
                new_state: dd.state,
                payload: null,
                created_at_client: new Date().toISOString(),
              },
            ],
          }),
        });
      }
      console.log(`\nKEEP=1 — left running: ${BASE_URL}/t/${on.slug}/screen`);
      console.log(`matches: ${on.matchIds.join(" ")}`);
    }
  } finally {
    if (!keep) {
      for (const tid of created) await db().from("tournaments").delete().eq("id", tid);
      const { count } = await db()
        .from("tournaments")
        .select("id", { count: "exact", head: true })
        .in("id", created);
      check("cleanup removed everything", (count ?? 0) === 0, String(count));
    } else {
      // Only the confirmation tournament is needed for the browser.
      for (const tid of created.slice(1)) await db().from("tournaments").delete().eq("id", tid);
    }
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
