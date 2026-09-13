/**
 * Live controls and the closing ceremony, end to end against the live project.
 *
 * Plays a Cup + Plate tournament through to both finals, then drives the screen
 * commands exactly as the control room does (through the same server functions,
 * without the cookie layer): the ceremony sequence and its clamping, a replay
 * that reaches only the screens covering its court, a break's server-stamped
 * countdown, mute, the compare-and-swap refusing a stale press, and a friendly
 * session's podium from its ranking with ties.
 *
 * Creates and deletes its own data. No dev server needed.
 *
 *   npx tsx --env-file=.env.local scripts/e2e/ceremony.ts
 */
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState } from "../../src/lib/scoring/engine";
import {
  approveBracket,
  finalizeMatch,
  generateBracket,
  generateGroupMatches,
  publishBracket,
  recalcStandings,
  upsertSnapshotFromState,
} from "../../src/lib/ops";
import { createScreen, ensureMainScreen, updateScreen } from "../../src/lib/screens";
import { getMatches, getScreenSettings, getTournament } from "../../src/lib/data";
import { createFriendlySession } from "../../src/lib/friendly/ops";
import { buildCeremony } from "../../src/lib/tv/ceremonyServer";
import { ceremonySteps } from "../../src/lib/tv/ceremony";
import { modeChangeEffects } from "../../src/lib/tv/commands";
import { applyCommandToScreens, applyScreenCommand } from "../../src/lib/tv/commandsServer";
import { buildLiveFeed } from "../../src/lib/tv/liveFeedServer";
import { DEFAULT_SCORING_CONFIG, type Match } from "../../src/lib/types";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function play(match: Match, winner: "A" | "B") {
  let state = initialScoreState("A");
  const loser = winner === "A" ? "B" : "A";
  for (let g = 0; g < 2; g++) for (let p = 0; p < 4; p++) state = awardPoint(state, loser, DEFAULT_SCORING_CONFIG);
  for (let g = 0; g < 6; g++) for (let p = 0; p < 4; p++) state = awardPoint(state, winner, DEFAULT_SCORING_CONFIG);
  await upsertSnapshotFromState(match, state, 32);
  await finalizeMatch(match, { status: "completed", winnerTeamId: winner === "A" ? match.team_a_id! : match.team_b_id!, actorRole: "e2e" });
}

async function screen(tid: string, key: string) {
  const s = await getScreenSettings(tid, key);
  if (!s) throw new Error(`no screen ${key}`);
  return s;
}

async function main() {
  console.log("— Live controls and ceremony end-to-end —");
  const { data: t, error } = await db()
    .from("tournaments")
    .insert({
      name: "E2E Ceremony",
      slug: `e2e-ceremony-${Date.now()}`,
      sport: "padel",
      status: "active",
      is_demo: true,
      public_access_enabled: true,
      format_config: {
        type: "group_knockout",
        qualifyPerGroup: 2,
        thirdPlaceMatch: true,
        tiers: {
          cup: { thirdPlaceMatch: true, podiumDepth: 4 },
          plate: { enabled: true, perGroup: 2, thirdPlaceMatch: false, podiumDepth: 2 },
        },
      },
    })
    .select()
    .single();
  if (error || !t) throw new Error(error?.message ?? "no tournament");
  const tid = t.id as string;
  const profileIds: string[] = [];
  let sessionBacking: string | null = null;

  try {
    // ---------- a tournament played to both finals ----------
    // Created by every real tournament-creation path; this script inserts directly.
    await ensureMainScreen(tid);
    await db().from("courts").insert([1, 2, 3, 4].map((n) => ({ tournament_id: tid, court_name: `Court ${n}`, court_order: n })));
    const { data: courts } = await db().from("courts").select("id, court_order").eq("tournament_id", tid).order("court_order");
    const { data: teams } = await db()
      .from("teams")
      .insert(Array.from({ length: 16 }, (_, i) => ({ tournament_id: tid, team_name: `Team ${i + 1}`, seed_number: i + 1, check_in_status: "checked_in" })))
      .select("id, seed_number");
    const sorted = (teams ?? []).sort((a, b) => a.seed_number - b.seed_number);
    await db().from("players").insert(sorted.flatMap((tm, i) => [
      { tournament_id: tid, team_id: tm.id, player_order: 1, full_name: `Player ${i * 2 + 1}` },
      { tournament_id: tid, team_id: tm.id, player_order: 2, full_name: `Player ${i * 2 + 2}` },
    ]));
    const { data: groups } = await db()
      .from("groups")
      .insert(["A", "B", "C", "D"].map((g, i) => ({ tournament_id: tid, group_name: `Group ${g}`, group_order: i + 1, status: "published" })))
      .select("id, group_order");
    const g = (groups ?? []).sort((a, b) => a.group_order - b.group_order);
    await db().from("group_teams").insert(sorted.map((tm, i) => ({ tournament_id: tid, group_id: g[i % 4].id, team_id: tm.id, position: Math.floor(i / 4) + 1 })));
    await generateGroupMatches(tid, "e2e");
    const seed = new Map(sorted.map((tm) => [tm.id, tm.seed_number]));
    for (const m of await getMatches(tid)) await play(m, (seed.get(m.team_a_id!) ?? 0) < (seed.get(m.team_b_id!) ?? 0) ? "A" : "B");
    await recalcStandings(tid);
    await generateBracket(tid, "e2e", "cup");
    await generateBracket(tid, "e2e", "plate");
    await approveBracket(tid, "e2e", "cup");
    await approveBracket(tid, "e2e", "plate");
    await publishBracket(tid, "e2e", { courtStrategy: "parallel" });
    // Play every knockout match as soon as both sides are known, until none is left.
    for (let round = 0; round < 10; round++) {
      const ready = (await getMatches(tid)).filter((m) => m.bracket_id && m.status === "scheduled" && m.team_a_id && m.team_b_id);
      if (ready.length === 0) break;
      for (const m of ready) await play(m, "A");
    }
    const tournament = (await getTournament(tid))!;

    // ---------- the ceremony sequence ----------
    const both = await buildCeremony(tournament, { bracket_tier: "both" });
    check("the ceremony runs the Plate first, then the Cup", both.map((x) => x.key).join(",") === "plate,cup", both.map((x) => x.key).join(","));
    check(
      "each tier reveals its configured depth: Plate 2, Cup 4",
      both[0]?.places.length === 2 && both[1]?.places.length === 4,
      both.map((x) => `${x.key}:${x.places.length}`).join(" "),
    );
    const steps = ceremonySteps(both);
    check("two slates and six places make eight steps", steps.length === 8, String(steps.length));
    const cupOnly = await buildCeremony(tournament, { bracket_tier: "cup" });
    check("a screen set to the Cup runs only the Cup", cupOnly.length === 1 && cupOnly[0].key === "cup");
    const leak = JSON.stringify(both);
    check("the ceremony carries no phone numbers or notes", !leak.includes("phone") && !leak.includes("notes"));

    await updateScreen(tid, "main", (await screen(tid, "main")).revision, { display_mode: "ceremony", bracket_tier: "both", ceremony_step: 0 }, "e2e");
    let main = await screen(tid, "main");
    for (let i = 0; i < 9; i++) {
      const r = await applyScreenCommand(tid, "main", main.revision, { kind: "ceremony", move: "next" }, "e2e");
      if (!r.ok) throw new Error(`next failed: ${JSON.stringify(r)}`);
      main = await screen(tid, "main");
    }
    check("NEXT PLACE stops at the champion instead of running past the end", main.ceremony_step === 7, String(main.ceremony_step));
    const stampBefore = main.ceremony_step_at;
    await new Promise((r) => setTimeout(r, 20));
    await applyScreenCommand(tid, "main", main.revision, { kind: "ceremony", move: "replay" }, "e2e");
    main = await screen(tid, "main");
    check("REPLAY keeps the step and re-stamps it, so the wall plays it again", main.ceremony_step === 7 && main.ceremony_step_at !== stampBefore);
    await applyScreenCommand(tid, "main", main.revision, { kind: "ceremony", move: "back" }, "e2e");
    main = await screen(tid, "main");
    check("BACK steps down one", main.ceremony_step === 6, String(main.ceremony_step));
    const stale = await applyScreenCommand(tid, "main", main.revision - 1, { kind: "ceremony", move: "next" }, "e2e");
    check(
      "a press from a console showing an older revision is refused, not applied twice",
      !stale.ok && "conflict" in stale && stale.conflict === true,
    );
    check("…and the step did not move", (await screen(tid, "main")).ceremony_step === 6);
    await applyScreenCommand(tid, "main", main.revision, { kind: "ceremony", move: "restart" }, "e2e");
    main = await screen(tid, "main");
    check("RESTART returns to the opening slate", main.ceremony_step === 0);

    // ---------- break ----------
    await applyScreenCommand(tid, "main", main.revision, { kind: "break_start", minutes: 10 }, "e2e");
    main = await screen(tid, "main");
    const span = Date.parse(main.break_ends_at ?? "") - Date.parse(main.break_started_at ?? "");
    check("a 10-minute break is stamped as exactly 10 minutes from the server's clock", span === 600_000, String(span));
    const feed = await buildLiveFeed(tid, main);
    check("the live feed carries the break's end, so every wall counts to the same moment", feed.screen.break_ends_at === main.break_ends_at);
    await applyScreenCommand(tid, "main", main.revision, { kind: "break_end" }, "e2e");
    main = await screen(tid, "main");
    check("ending the break clears it", main.break_ends_at === null && main.break_started_at === null);

    // ---------- mute ----------
    await applyScreenCommand(tid, "main", main.revision, { kind: "mute", on: true }, "e2e");
    main = await screen(tid, "main");
    check("mute is on", main.mute_animations === true);
    check("the feed tells the wall to mute", (await buildLiveFeed(tid, main)).screen.mute_animations === true);
    await applyScreenCommand(tid, "main", main.revision, { kind: "mute", on: false }, "e2e");
    check("…and off again", (await screen(tid, "main")).mute_animations === false);

    // ---------- replay entrance, and pushing to several walls ----------
    const tv1 = await createScreen(tid, "TV 1", "e2e");
    const tv2 = await createScreen(tid, "TV 2", "e2e");
    const c = courts ?? [];
    await updateScreen(tid, tv1.key!, (await screen(tid, tv1.key!)).revision, { court_ids: [c[0].id, c[1].id], display_mode: "live" }, "e2e");
    await updateScreen(tid, tv2.key!, (await screen(tid, tv2.key!)).revision, { court_ids: [c[2].id, c[3].id], display_mode: "live" }, "e2e");
    const { data: liveMatch } = await db()
      .from("matches")
      .insert({ tournament_id: tid, stage: "knockout", round_name: "Exhibition", match_order: 999, court_id: c[0].id, team_a_id: sorted[0].id, team_b_id: sorted[1].id, status: "live", started_at: new Date().toISOString() })
      .select("id")
      .single();
    const replay = await applyCommandToScreens(tid, [tv1.key!, tv2.key!], { kind: "replay_entrance", matchId: liveMatch!.id }, "e2e");
    check(
      "a replay reaches the wall covering that court and skips the other, saying why",
      replay.updated.length === 1 && replay.skipped.length === 1 && replay.skipped[0].reason === "that court is not on it",
      JSON.stringify(replay),
    );
    const stamped = (await screen(tid, tv1.key!)).entrance_replay;
    check("the covering wall got the replay stamp", stamped?.match_id === liveMatch!.id);
    check("…with the match's event number at the press, so only a later point ends it", stamped?.event_number === 0, String(stamped?.event_number));
    await updateScreen(tid, "main", (await screen(tid, "main")).revision, { display_mode: "leaderboard" }, "e2e");
    const offLive = await applyScreenCommand(tid, "main", (await screen(tid, "main")).revision, { kind: "replay_entrance", matchId: liveMatch!.id }, "e2e");
    check(
      "a replay on a screen not showing live courts is refused, not reported as on air",
      !offLive.ok && "skipped" in offLive && offLive.message.includes("not showing live courts"),
      "message" in offLive ? offLive.message : "applied",
    );

    // The same two walls, now in the ceremony at different steps.
    for (const [key, step] of [[tv1.key!, 2], [tv2.key!, 5]] as const) {
      const s0 = await screen(tid, key);
      await updateScreen(tid, key, s0.revision, { ...modeChangeEffects({ display_mode: "ceremony", bracket_tier: "both" }, s0, Date.now()), ceremony_step: step }, "e2e");
    }
    const notLive = await applyScreenCommand(tid, "main", (await screen(tid, "main")).revision, { kind: "replay_entrance", matchId: sorted[0].id }, "e2e");
    check("replaying something that is not a live match is refused", !notLive.ok && "skipped" in notLive);

    // One wall moved by someone else since the control room showed it at step 1.
    const behind = await applyCommandToScreens(tid, [tv1.key!], { kind: "ceremony", move: "next" }, "e2e", {
      expectedSteps: new Map([[tv1.key!, 1]]),
    });
    check(
      "a pushed NEXT from a control room a step behind is refused for that wall, not applied twice",
      behind.conflicted.length === 1 && behind.updated.length === 0 && (await screen(tid, tv1.key!)).ceremony_step === 2,
      JSON.stringify(behind),
    );
    await applyCommandToScreens(tid, [tv1.key!, tv2.key!], { kind: "ceremony", move: "next" }, "e2e", {
      expectedSteps: new Map([[tv1.key!, 2], [tv2.key!, 5]]),
    });
    const [s1, s2] = [await screen(tid, tv1.key!), await screen(tid, tv2.key!)];
    check("NEXT PLACE pushed to two walls moves each from its own step", s1.ceremony_step === 3 && s2.ceremony_step === 6, `${s1.ceremony_step}, ${s2.ceremony_step}`);
    // Switching an on-air ceremony to the Cup only restarts it: its stored step was
    // a position in the Plate-then-Cup sequence.
    const beforeSwitch = await screen(tid, tv2.key!);
    await updateScreen(tid, tv2.key!, beforeSwitch.revision, modeChangeEffects({ bracket_tier: "cup" }, beforeSwitch, Date.now()), "e2e");
    check("changing the podiums shown on air restarts from the slate", (await screen(tid, tv2.key!)).ceremony_step === 0);
    // A wall showing only the Cup has a shorter ceremony; NEXT clamps to its own end.
    const cupWall = await screen(tid, tv2.key!);
    await updateScreen(tid, tv2.key!, cupWall.revision, { ceremony_step: 4 }, "e2e");
    await applyCommandToScreens(tid, [tv2.key!], { kind: "ceremony", move: "next" }, "e2e");
    check("a wall showing only the Cup stops at its own champion", (await screen(tid, tv2.key!)).ceremony_step === 4);
    check("…with one shared stamp, so walls in step stay in step", s1.ceremony_step_at !== null && s1.ceremony_step_at === s2.ceremony_step_at);
    await applyCommandToScreens(tid, [tv1.key!, tv2.key!], { kind: "break_start", minutes: 5 }, "e2e");
    const [b1, b2] = [await screen(tid, tv1.key!), await screen(tid, tv2.key!)];
    check("a break pushed to two walls ends at the same instant on both", b1.break_ends_at !== null && b1.break_ends_at === b2.break_ends_at);
    const moveOffAir = await applyCommandToScreens(tid, ["main"], { kind: "ceremony", move: "next" }, "e2e");
    check(
      "a pushed ceremony move skips a wall not showing the ceremony",
      moveOffAir.updated.length === 0 && moveOffAir.skipped[0]?.reason === "it is not showing the ceremony",
      JSON.stringify(moveOffAir),
    );

    // ---------- a friendly session's podium, with a tie ----------
    const suffix = Date.now();
    const { data: profiles } = await db()
      .from("player_profiles")
      .insert(["Ali", "Badr", "Celine", "Dina", "Emad"].map((n) => ({ public_name: `${n} ${suffix}`, approval_status: "approved" })))
      .select("id, public_name");
    profileIds.push(...(profiles ?? []).map((p) => p.id as string));
    const session = await createFriendlySession({
      name: `E2E Ceremony Session ${suffix}`,
      seasonId: null,
      startsAt: null,
      durationMinutes: null,
      courtCount: 1,
      pairingMode: "americano",
      rankingModel: "win_points",
      setsToWinMatch: 1,
      gamesToWinSet: 6,
      maxPlayers: null,
      registrationDeadline: null,
      actorRole: "e2e",
    });
    sessionBacking = session.tournament_id as string;
    const ranks = [1, 2, 2, 4, 5];
    await db().from("friendly_ranking_snapshots").insert(
      profileIds.map((pid, i) => ({ scope: "session", scope_id: session.id, player_profile_id: pid, rank: ranks[i], points: 20 - ranks[i] })),
    );
    const backing = (await getTournament(sessionBacking))!;
    const sessionTiers = await buildCeremony(backing, { bracket_tier: "cup" });
    const places = sessionTiers[0]?.places ?? [];
    check(
      "a session's podium comes from its ranking, top 3 by default, with the tie on one step",
      places.length === 2 && places[1].place === 2 && places[1].entrants.length === 2 && places[0].entrants.length === 1,
      places.map((p) => `${p.place}:${p.entrants.length}`).join(" "),
    );
    check("…under the session's own name", sessionTiers[0]?.label === session.name);
    await db().from("tournaments").update({ format_config: { ...(backing.format_config ?? {}), tiers: { cup: { podiumDepth: 4 } } } }).eq("id", sessionBacking);
    const deeper = await buildCeremony((await getTournament(sessionBacking))!, { bracket_tier: "cup" });
    check("the session's podium depth setting reveals the 4th place too", deeper[0]?.places.map((p) => p.place).join(",") === "1,2,4");
  } finally {
    await db().from("tournaments").delete().eq("id", tid);
    if (sessionBacking) await db().from("tournaments").delete().eq("id", sessionBacking);
    if (profileIds.length > 0) await db().from("player_profiles").delete().in("id", profileIds);
    const { count } = await db().from("tournaments").select("id", { count: "exact", head: true }).in("id", [tid, sessionBacking ?? tid]);
    check("cleanup removed everything", (count ?? 0) === 0, String(count));
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
