/**
 * Match and tie stats for fans, end to end (stand-in only): a singles rubber played
 * through the real events API (aces, a double fault, a break of serve, an Undo),
 * then GET /api/mobile/v1/matches/[id]/stats and /ties/[id]/stats checked against
 * what was played; a second rubber listing the teams the other way round (the tie
 * sums are turned onto the tie's sides) and a third entered as a final score
 * ("Recorded point by point only"); the organiser's "Show aces on TV & app" switch;
 * nothing private in the payload; a tournament that is not public: 404; the public
 * web match page draws the card.
 *
 *   LOCALDB_PORT=54333 npm run localdb                   # terminal 1
 *   npm run build && (set -a; . ./.env.localdb; set +a; SUPABASE_URL=http://localhost:54333 \
 *     PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1 npx next start -p 3083)   # terminal 2
 *   SUPABASE_URL=http://localhost:54333 BASE_URL=http://localhost:3083 npm run e2e:stats
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import * as C from "../../src/lib/scoring/console";
import type { ScoreState, TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import type { MatchStatsResult, TieStats } from "../../src/lib/scoring/stats";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../../src/lib/types";
import { assertStandIn, check, finish, fixtures, http, section, sleep, staff, type Who } from "./lib/fixtures";

const ADMIN = staff("admin");

/** A console that sends each step through the events API. */
class Scorer {
  state: ScoreState | null = null;
  n = 0;
  history: ScoreState[] = [];
  constructor(
    private matchId: string,
    private who: Who,
    private device: string,
    private ids: Record<TeamKey, string>,
    readonly opts: C.ConsoleOptions,
  ) {}
  async step(f: (s: ScoreState) => C.ConsoleEvent | null) {
    const e = f(this.state!);
    if (!e) throw new Error("the console refused the step");
    this.n++;
    const ev = {
      client_event_id: randomUUID(),
      event_number: this.n,
      event_type: e.eventType,
      team_id: e.team ? this.ids[e.team] : null,
      previous_state: this.state,
      new_state: e.next,
      payload: e.winner ? { ...(e.payload ?? {}), winner_team_id: this.ids[e.winner] } : e.payload,
      created_at_client: new Date().toISOString(),
    };
    const r = await http("POST", `/api/matches/${this.matchId}/events`, this.who, { deviceId: this.device, events: [ev] });
    if (r.status !== 200) throw new Error(`event ${e.eventType} refused: ${r.status} ${JSON.stringify(r.json)}`);
    this.history = C.nextHistory(this.history, this.state, e.eventType);
    this.state = e.next;
    return r;
  }
  point(team: TeamKey) {
    return this.step((s) => C.point(s, team, this.opts));
  }
}

async function main() {
  assertStandIn("stats");
  await db().from("request_counters").delete().like("bucket_key", "staff-%");
  const tag = randomUUID().slice(0, 6);
  const f = fixtures(tag);
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  try {
    const T = await f.tournament({ name: "Stats", sport: "tennis", scoring: DEFAULT_TENNIS_SCORING_CONFIG as unknown as Record<string, unknown> });
    await db().from("tournaments").update({ public_access_enabled: true, organization_id: (mb as { id: string }).id }).eq("id", T);
    const { data: trow } = await db().from("tournaments").select("slug, match_day_rules").eq("id", T).single();
    const slug = (trow as { slug: string }).slug;
    const [court] = await f.courts(T, 1);
    const st = await f.teams(T, ["Egypt", "Kenya"], 2);
    const [EGY, KEN] = st.teams;
    const { data: tieRow, error: te } = await db()
      .from("ties")
      .insert({ tournament_id: T, stage: "group", group_id: st.groupId, round_no: 1, tie_order: 1, team_a_id: EGY.id, team_b_id: KEN.id, status: "live", court_id: court })
      .select("id")
      .single();
    if (te) throw new Error(`ties: ${te.message}`);
    const tieId = (tieRow as { id: string }).id;
    const rubber = (no: number, type: string, a: string, b: string, pa: string, pb: string) =>
      f.match(T, { team_a_id: a, team_b_id: b, court_id: court, group_id: st.groupId, match_order: no, tie_id: tieId, rubber_no: no, rubber_type: type as never, team_a_player_ids: [pa], team_b_player_ids: [pb] });
    const R1 = await rubber(1, "S2", EGY.id, KEN.id, EGY.players[1], KEN.players[1]);
    // The second rubber lists Kenya first.
    const R2 = await rubber(2, "S1", KEN.id, EGY.id, KEN.players[0], EGY.players[0]);
    const R3 = await rubber(3, "D", EGY.id, KEN.id, EGY.players[0], KEN.players[0]);
    const config = scoringConfigForMatch({ sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG }, { stage: "group" });
    const opts: C.ConsoleOptions = { config, confirmFirst: false, online: true, tennis: true, doubles: false };

    section("A rubber played point by point: aces, a double fault, a break, an Undo");
    const claim = await http("POST", `/api/matches/${R1.id}/claim`, ADMIN, { deviceId: `stats-${tag}`, deviceLabel: "Stats phone" });
    check(claim.status === 200, "the admin's console takes rubber 1", claim.json);
    const s1 = new Scorer(R1.id, ADMIN, `stats-${tag}`, { A: EGY.id, B: KEN.id }, opts);
    await s1.step(() => C.startMatch("A"));
    // Game 1, Egypt serving: ace, ace, double fault, ace, then a point to Egypt: game Egypt (40-15).
    await s1.step((x) => C.aceEvent(x, opts));
    await s1.step((x) => C.aceEvent(x, opts));
    await s1.step((x) => C.faultEvent(x, opts));
    await s1.step((x) => C.faultEvent(x, opts));
    await s1.step((x) => C.aceEvent(x, opts));
    await s1.point("A");
    // Game 2, Kenya serving: Egypt breaks to love; a Kenya ace taken back by Undo on the way.
    await s1.point("A");
    await s1.step((x) => C.aceEvent(x, opts));
    await s1.step(() => C.undo(s1.history, false));
    await s1.point("A");
    await s1.point("A");
    await s1.point("A");
    check(s1.state!.teamA.games === 2 && s1.state!.teamB.games === 0, "the console's score: 2-0 Egypt", { a: s1.state!.teamA.games, b: s1.state!.teamB.games });

    await sleep(2200);
    const ms = await http("GET", `/api/mobile/v1/matches/${R1.id}/stats`);
    const stats = ms.json?.stats as MatchStatsResult | undefined;
    check(ms.status === 200 && stats?.available === true, "GET matches/[id]/stats: 200, available", ms.json);
    check(/public/.test(ms.cache ?? "") && /s-maxage=3\b/.test(ms.cache ?? ""), "CDN-cacheable for a few seconds while live", ms.cache);
    if (stats?.available) {
      const { A, B } = stats.sides;
      check(A.aces === 3 && B.aces === 0, "aces: Egypt 3, Kenya 0 (the undone ace does not count)", { A: A.aces, B: B.aces });
      check(A.doubleFaults === 1 && B.doubleFaults === 0, "double faults: Egypt 1 (two faults)", { A: A.doubleFaults, B: B.doubleFaults });
      check(A.pointsWon === 8 && B.pointsWon === 1 && stats.points === 9, "points won: Egypt 8, Kenya 1", { A: A.pointsWon, B: B.pointsWon, points: stats.points });
      check(A.servicePointsPlayed === 5 && A.servicePointsWon === 4 && A.returnPointsPlayed === 4 && A.returnPointsWon === 4, "on serve 4/5, on return 4/4 for Egypt", A);
      check(A.breakPointChances === 1 && A.breakPointsWon === 1 && B.breakPointChances === 0, "break points: Egypt 1/1 (at 0-40), Kenya 0/0", { A: [A.breakPointsWon, A.breakPointChances], B: [B.breakPointsWon, B.breakPointChances] });
      check(A.gamesWon === 2 && B.gamesWon === 0 && A.longestRun === 6, "games 2-0, Egypt's longest run 6", { games: [A.gamesWon, B.gamesWon], run: A.longestRun });
      check(typeof stats.durationSeconds === "number" && stats.sets.length === 1 && stats.sets[0].label === "Set 1", "a match length and one set's length", { d: stats.durationSeconds, sets: stats.sets });
    }
    const text = JSON.stringify(ms.json);
    check(!/created_by|referee|actor|access_code|phone|email/i.test(text), "nothing private in the payload (no referee, no who-entered-it, no contact)", text.slice(0, 300));

    section("Rubber 2 with the teams the other way round, rubber 3 entered as a final score");
    await http("POST", `/api/matches/${R2.id}/claim`, ADMIN, { deviceId: `stats-${tag}`, deviceLabel: "Stats phone" });
    // Kenya is side A here: Kenya serves an ace, Egypt wins the next point.
    const s2 = new Scorer(R2.id, ADMIN, `stats-${tag}`, { A: KEN.id, B: EGY.id }, opts);
    await s2.step(() => C.startMatch("A"));
    await s2.step((x) => C.aceEvent(x, opts));
    await s2.point("B");
    await db().from("matches").update({ status: "completed", result_source: "final_score", winner_team_id: EGY.id }).eq("id", R3.id);
    const r3 = await http("GET", `/api/mobile/v1/matches/${R3.id}/stats`);
    const r3s = r3.json?.stats as MatchStatsResult | undefined;
    check(r3.status === 200 && r3s?.available === false && r3s.reason === "final_score" && /point by point only/.test(r3s.note), "a final-score rubber: unavailable, recorded point by point only", r3.json);
    check(/s-maxage=60\b/.test(r3.cache ?? ""), "a finished match is cached longer", r3.cache);

    await sleep(3200);
    const ts = await http("GET", `/api/mobile/v1/ties/${tieId}/stats`);
    const tstats = ts.json?.stats as TieStats | undefined;
    check(ts.status === 200 && tstats?.available === true && tstats.counted === 2 && ts.json?.a === EGY.id, "GET ties/[id]/stats: two rubbers counted, side A is the tie's Egypt", ts.json);
    if (tstats?.sides) {
      check(tstats.sides.A.aces === 3 && tstats.sides.B.aces === 1, "tie aces: Egypt 3, Kenya 1 (rubber 2 turned onto the tie's sides)", { A: tstats.sides.A.aces, B: tstats.sides.B.aces });
      check(tstats.sides.A.pointsWon === 9 && tstats.sides.B.pointsWon === 2, "tie points won: Egypt 9, Kenya 2", { A: tstats.sides.A.pointsWon, B: tstats.sides.B.pointsWon });
      check(typeof tstats.timeOnCourtSeconds === "number" && /final score/.test(tstats.note ?? ""), "time on court, and a note that the final-score rubber is left out", { time: tstats.timeOnCourtSeconds, note: tstats.note });
    }

    section("The organiser hides aces: no aces in the stats");
    const rules = (trow as { match_day_rules: Record<string, unknown> }).match_day_rules;
    await db().from("tournaments").update({ match_day_rules: { ...rules, features: { ...((rules.features as Record<string, unknown>) ?? {}), tvAces: false } } }).eq("id", T);
    await sleep(3200);
    const off = await http("GET", `/api/mobile/v1/matches/${R1.id}/stats`);
    const offS = off.json?.stats as MatchStatsResult | undefined;
    check(off.status === 200 && offS?.available === true && offS.aces === false && !("aces" in offS.sides.A) && !("aces" in offS.sides.B), "\"Show aces on TV & app\" off: aces omitted", offS);
    const offT = await http("GET", `/api/mobile/v1/ties/${tieId}/stats`);
    const offSides = (offT.json?.stats as TieStats | undefined)?.sides;
    check(offT.status === 200 && Boolean(offSides) && !("aces" in offSides!.A) && !("aces" in offSides!.B), "…and from the tie's sums", offSides);

    section("The public web match page draws the Stats card");
    const page = await http("GET", `/t/${slug}/match/${R1.id}`);
    const html = String(page.text ?? "");
    check(page.status === 200 && html.includes('data-testid="match-stats"') && html.includes("Break points won"), "the web match page has the Stats card", { status: page.status });

    section("Not public: 404");
    await db().from("tournaments").update({ public_access_enabled: false }).eq("id", T);
    await sleep(3200);
    const hidden = await http("GET", `/api/mobile/v1/matches/${R1.id}/stats`);
    const hiddenTie = await http("GET", `/api/mobile/v1/ties/${tieId}/stats`);
    check(hidden.status === 404 && hiddenTie.status === 404, "a tournament that is not public: match and tie stats 404", { match: hidden.status, tie: hiddenTie.status });
    const missing = await http("GET", `/api/mobile/v1/matches/${randomUUID()}/stats`);
    check(missing.status === 404, "an unknown match: 404", missing.status);
  } finally {
    const clean = await f.cleanup();
    check(clean, "cleaned up its rows");
  }
  finish("stats");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
