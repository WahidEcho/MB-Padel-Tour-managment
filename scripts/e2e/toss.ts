/**
 * The toss end to end (stand-in only, owner 31 Oct 2026): a chair umpire signed in with a court code
 * and PIN starts a singles and a doubles match from the toss through the real events API.
 *
 *  - MATCH_STARTED carries the toss (payload and state) and the starting sides; the server keeps it
 *    and its point checks (shadow states) accept every point after it.
 *  - The sides follow the changes of ends (timing.ts leftTeamNow) on the server's own snapshot.
 *  - Doubles: the toss and the first server / receiver (SERVE_ORDER) go in one batch.
 *  - The match log says the toss in words; the court TV feed carries it before the first point.
 *  - Without a toss ("Skip the toss") a match starts exactly as before.
 *
 *   npm run localdb                                  # terminal 1
 *   (set -a; . ./.env.localdb; set +a; npx next dev -p 3078)   # terminal 2 (or next start)
 *   BASE_URL=http://localhost:3078 npm run e2e:toss  # terminal 3
 *
 * KEEP=1 leaves the rows in place (for screenshots) and prints a fresh match, the court code and PIN.
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import * as C from "../../src/lib/scoring/console";
import { type ScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { answerToss, tossQuestion, tossRecord, tossSentence, type TossAnswers } from "../../src/lib/scoring/toss";
import { leftTeamNow } from "../../src/lib/scoring/timing";
import { generateEventCode, hashEventCode } from "../../src/lib/orgs/codes";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { DEFAULT_TENNIS_SCORING_CONFIG, type ScoringConfig } from "../../src/lib/types";
import { assertStandIn, bearer, check, finish, fixtures, http, refereeWithPin, section, sleep, type Who } from "./lib/fixtures";

const SESSION = "/api/mobile/v1/staff/session";

function toss(...values: string[]): TossAnswers {
  let a: TossAnswers = {};
  for (const v of values) a = answerToss(a, tossQuestion(a)!, v as never);
  return a;
}

/** A console as the clients run it: shared console events, sent in order. */
class Scorer {
  state: ScoreState | null = null;
  n = 0;
  opts: C.ConsoleOptions;
  constructor(private matchId: string, private who: Who, private ids: Record<TeamKey, string>, config: ScoringConfig, doubles: boolean) {
    this.opts = { config, confirmFirst: false, online: true, tennis: true, doubles };
  }
  build(e: C.ConsoleEvent | null) {
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
    this.state = e.next;
    return ev;
  }
  send(...events: ReturnType<Scorer["build"]>[]) {
    return http("POST", `/api/matches/${this.matchId}/events`, this.who, { deviceId: `toss-${this.matchId}`, events });
  }
  step(f: (s: ScoreState) => C.ConsoleEvent | null) {
    return this.send(this.build(f(this.state!)));
  }
}

async function snapshotOf(matchId: string): Promise<ScoreState> {
  const { data } = await db().from("match_score_snapshots").select("snapshot_json").eq("match_id", matchId).single();
  return (data as { snapshot_json: ScoreState }).snapshot_json;
}

async function main() {
  assertStandIn("toss");
  for (const prefix of ["staff-", "devices", "pin"]) await db().from("request_counters").delete().like("bucket_key", `${prefix}%`);
  const tag = randomUUID().slice(0, 6);
  const f = fixtures(tag);
  const codes: string[] = [];
  const keep = process.env.KEEP === "1";
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;

  try {
    const T = await f.tournament({ name: "Toss", sport: "tennis", scoring: DEFAULT_TENNIS_SCORING_CONFIG as unknown as Record<string, unknown> });
    await db().from("tournaments").update({ public_access_enabled: true, organization_id: MB }).eq("id", T);
    const { data: trow } = await db().from("tournaments").select("slug").eq("id", T).single();
    const slug = (trow as { slug: string }).slug;
    const [c1] = await f.courts(T, 1);
    const st = await f.teams(T, ["Egypt", "Spain"], 1);
    const dt = await f.teams(T, ["France", "Japan"], 2);
    const S = await f.match(T, { team_a_id: st.teams[0].id, team_b_id: st.teams[1].id, court_id: c1, group_id: st.groupId, match_order: 1 });
    const D = await f.match(T, { team_a_id: dt.teams[0].id, team_b_id: dt.teams[1].id, court_id: c1, group_id: dt.groupId, match_order: 2 });
    const P = await f.match(T, { team_a_id: st.teams[1].id, team_b_id: st.teams[0].id, court_id: c1, group_id: st.groupId, match_order: 3 });
    const K = keep ? await f.match(T, { team_a_id: dt.teams[1].id, team_b_id: dt.teams[0].id, court_id: c1, group_id: dt.groupId, match_order: 4 }) : null;

    const umpire = await refereeWithPin(MB, `Nadia Toss ${tag}`);
    const courtCode = generateEventCode();
    const { data: cr, error: ce } = await db()
      .from("organization_codes")
      .insert({ organization_id: MB, role: "referee", tournament_id: T, court_name: "Court 1", code_hash: hashEventCode(courtCode), label: `e2e toss ${tag}` })
      .select("id");
    if (ce) throw new Error(`organization_codes: ${ce.message}`);
    codes.push(...((cr ?? []) as { id: string }[]).map((r) => r.id));
    const signIn = await http("POST", SESSION, { "X-Forwarded-For": "198.51.100.81" }, { code: courtCode, pin: umpire.pin });
    check(signIn.status === 200, "a chair umpire signs in with the court code and their PIN", signIn.json?.error);
    const UMPIRE = bearer(String(signIn.json?.token));
    const boot = await http("GET", `/api/mobile/v1/referee/matches/${S.id}/bootstrap`, UMPIRE);
    const config = boot.json?.config as ScoringConfig;

    /* ---------------- singles ---------------- */
    section("Singles: Spain wins the toss and lets Egypt choose; Egypt serve, Spain take the left side");
    const ids = { A: st.teams[0].id, B: st.teams[1].id };
    const rec = tossRecord(toss("B", "defer", "serve", "left"))!;
    check(rec.servingTeam === "A" && rec.leftTeam === "B", "the toss: Egypt serve, Spain on the chair umpire's left", rec);
    const s = new Scorer(S.id, UMPIRE, ids, config, false);
    let r = await s.send(s.build(C.startMatch(rec.servingTeam, rec)));
    check(r.status === 200, "MATCH_STARTED with the toss is accepted", r.json?.error);
    const snap0 = await snapshotOf(S.id);
    check(snap0.toss?.winner === "B" && snap0.leftAtStart === "B" && snap0.servingTeam === "A", "the server keeps the toss and the starting sides", { toss: snap0.toss, left: snap0.leftAtStart });
    check(leftTeamNow(snap0) === "B", "before the first point Spain stand on the left", leftTeamNow(snap0));

    await sleep(600);
    const live0 = await http("GET", `/api/t/${slug}/live`);
    const tvState = ((live0.json?.snapshots ?? []) as { match_id: string; state?: ScoreState }[]).find((x) => x.match_id === S.id)?.state;
    check(live0.status === 200 && tvState?.toss?.winner === "B", "the court TV feed carries the toss before the first point", { status: live0.status, toss: tvState?.toss });

    // Egypt hold the first game: the players change ends after it.
    for (let i = 0; i < 4; i++) {
      r = await s.step((x) => C.point(x, "A", s.opts));
      check(r.status === 200, `point ${i + 1} of game 1 is accepted (its state carries the toss)`, r.json?.error ?? r.json?.conflict);
    }
    const snap1 = await snapshotOf(S.id);
    check(snap1.teamA.games === 1 && snap1.toss?.winner === "B", "after game 1: 1-0, the toss still in the state", { games: snap1.teamA.games });
    check(leftTeamNow(snap1) === "A", "after the first game the ends have changed: Egypt on the left", leftTeamNow(snap1));
    // Spain hold game 2: no change of ends after an even game.
    for (let i = 0; i < 4; i++) await s.step((x) => C.point(x, "B", s.opts));
    check(leftTeamNow(await snapshotOf(S.id)) === "A", "after game 2 (1-1): no change, Egypt still on the left");
    for (let i = 0; i < 4; i++) await s.step((x) => C.point(x, "A", s.opts));
    check(leftTeamNow(await snapshotOf(S.id)) === "B", "after game 3 (2-1): ends change again, Spain on the left");

    const log = await http("GET", `/api/matches/${S.id}/log`, UMPIRE);
    const entries = (log.json?.entries ?? []) as { title: string; detail: string }[];
    const started = entries.find((e) => e.title === "Match started");
    const want = tossSentence(rec, (k) => (k === "A" ? st.teams[0].name : st.teams[1].name));
    check(log.status === 200 && started?.detail === want, "the match log says the toss in words", { got: started?.detail, want });

    /* ---------------- doubles ---------------- */
    section("Doubles: France win the toss and choose the right side; Japan receive; first server and receiver in one batch");
    const dIds = { A: dt.teams[0].id, B: dt.teams[1].id };
    const dRec = tossRecord(toss("A", "side", "right", "receive"))!;
    check(dRec.servingTeam === "A" && dRec.leftTeam === "B", "France serve (Japan chose to receive), Japan on the left", dRec);
    const d = new Scorer(D.id, UMPIRE, dIds, config, true);
    const start = d.build(C.startMatch(dRec.servingTeam, dRec));
    const order = d.build(C.serveOrderEvent(d.state!, { servingTeam: "A", server: 1, receiver: 1, otherServer: 0, otherReceiver: 0 }, true));
    r = await d.send(start, order);
    check(r.status === 200, "MATCH_STARTED with the toss and SERVE_ORDER are accepted together", r.json?.error ?? r.json?.conflict);
    const dSnap = await snapshotOf(D.id);
    check(dSnap.toss?.first.choice === "side" && dSnap.orderSet === 1 && dSnap.doublesOrder?.A === 1 && dSnap.receiveOrder?.B === 1, "the doubles snapshot has the toss and the first server / receiver", {
      toss: dSnap.toss?.first,
      orderSet: dSnap.orderSet,
      doublesOrder: dSnap.doublesOrder,
      receiveOrder: dSnap.receiveOrder,
    });
    for (let i = 0; i < 4; i++) {
      r = await d.step((x) => C.point(x, "A", d.opts));
      check(r.status === 200, `doubles point ${i + 1} accepted`, r.json?.error ?? r.json?.conflict);
    }
    check(leftTeamNow(await snapshotOf(D.id)) === "A", "after game 1 France move to the left");

    /* ---------------- no toss ---------------- */
    section("Skip the toss: a match starts as before");
    const p = new Scorer(P.id, UMPIRE, { A: st.teams[1].id, B: st.teams[0].id }, config, false);
    r = await p.send(p.build(C.startMatch("B")));
    const pSnap = await snapshotOf(P.id);
    check(r.status === 200 && pSnap.toss === undefined && pSnap.leftAtStart === undefined && leftTeamNow(pSnap) === null, "no toss, no sides: the console keeps its own swap", { toss: pSnap.toss });
    r = await p.step((x) => C.point(x, "B", p.opts));
    check(r.status === 200, "points go in as always", r.json?.error);

    if (keep && K) {
      console.log(`\nKEEP=1: tournament ${slug}; fresh doubles match ${K.id} (Japan v France); singles ${S.id}; court code ${courtCode} PIN ${umpire.pin}`);
    }
  } finally {
    if (!keep) {
      section("Cleanup");
      if (codes.length) {
        await db().from("referee_sessions").delete().in("code_id", codes);
        await db().from("organization_codes").delete().in("id", codes);
      }
      check(await f.cleanup(), "everything made here is removed");
    }
  }
  finish("Toss");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
