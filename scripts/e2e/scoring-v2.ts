/**
 * Scoring v2 end to end (stand-in only): a singles and a doubles match played
 * through the real events API with faults, double faults, aces, both lets, the
 * doubles serve order at every set, timers and the referee's time rulings; the
 * server's own state checked after each step; the match log (referee, master
 * referee, admin); the organiser's feature switches (admins only, switched-off
 * features refused, the console told through the bootstrap); and the aces and
 * timers the court TVs and the app read. Audit fixes: a v2 event must start from the
 * server's score (M2, 409 stale_state), a court code changes a finished match only
 * within 30 minutes of its end (L4, 409 finished_locked), no serve order in singles and
 * the rotation's serving team offered at every set (the referee may name the other), and a point closes a running
 * timer that Undo never brings back (L9).
 *
 *   npm run localdb                                      # terminal 1
 *   npm run build && (set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3077 \
 *     PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1 npx next start -p 3077)   # terminal 2
 *   npm run e2e:scoring-v2                               # terminal 3
 *
 * KEEP=1 leaves the rows in place (for screenshots) and prints their ids.
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import * as C from "../../src/lib/scoring/console";
import { currentServer, servingPlayer, type ScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { dueServingTeam, receivingPlayer, scoreKey, serveNumber } from "../../src/lib/scoring/serve";
import { tvExtras } from "../../src/components/broadcast/TvExtras";
import { SCORING_FEATURES_ON, matchDayRules } from "../../src/lib/matchday/rules";
import { generateEventCode, hashEventCode } from "../../src/lib/orgs/codes";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { DEFAULT_TENNIS_SCORING_CONFIG, type ScoringConfig } from "../../src/lib/types";
import { actionOk, callAction, form } from "./lib/actions";
import { assertStandIn, bearer, check, finish, fixtures, http, refereeWithPin, section, sleep, staff, type Who } from "./lib/fixtures";

const ip = (n: number): Who => ({ "X-Forwarded-For": `198.51.100.${n}` });
const SESSION = "/api/mobile/v1/staff/session";
const ADMIN = staff("admin");
const MANAGER = staff("manager");

/** A scoring console as the clients run it: builds events with the shared console, sends them in order. */
class Scorer {
  state: ScoreState | null = null;
  n = 0;
  sent: { type: string; payload: unknown }[] = [];
  opts: C.ConsoleOptions;
  constructor(
    private matchId: string,
    private who: Who,
    private device: string,
    private ids: Record<TeamKey, string>,
    config: ScoringConfig,
    doubles: boolean,
  ) {
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
    this.sent.push({ type: e.eventType, payload: e.payload });
    return ev;
  }
  async send(...events: ReturnType<Scorer["build"]>[]) {
    return http("POST", `/api/matches/${this.matchId}/events`, this.who, { deviceId: this.device, events });
  }
  /** Builds and sends one step; returns the reply. */
  async step(f: (s: ScoreState) => C.ConsoleEvent | null) {
    return this.send(this.build(f(this.state!)));
  }
  /** A step the server must refuse: nothing is kept on this side either. */
  async refused(f: (s: ScoreState) => C.ConsoleEvent | null) {
    const before = { state: this.state, n: this.n, sent: this.sent.length };
    const r = await this.step(f);
    this.state = before.state;
    this.n = before.n;
    this.sent.length = before.sent;
    return r;
  }
}

async function snapshotOf(matchId: string): Promise<ScoreState> {
  const { data } = await db().from("match_score_snapshots").select("snapshot_json").eq("match_id", matchId).single();
  return (data as { snapshot_json: ScoreState }).snapshot_json;
}

async function main() {
  assertStandIn("scoring-v2");
  for (const prefix of ["staff-", "devices", "pin"]) await db().from("request_counters").delete().like("bucket_key", `${prefix}%`);
  const tag = randomUUID().slice(0, 6);
  const f = fixtures(tag);
  const codes: string[] = [];
  const keep = process.env.KEEP === "1";
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;

  try {
    /* ---------------- fixtures ---------------- */
    const T = await f.tournament({ name: "Scoring V2", sport: "tennis", scoring: DEFAULT_TENNIS_SCORING_CONFIG as unknown as Record<string, unknown> });
    await db().from("tournaments").update({ public_access_enabled: true, organization_id: MB }).eq("id", T);
    const { data: trow } = await db().from("tournaments").select("slug").eq("id", T).single();
    const slug = (trow as { slug: string }).slug;
    const [c1, c2] = await f.courts(T, 2);
    const st = await f.teams(T, ["Egypt", "Usa"], 1);
    const dt = await f.teams(T, ["Spain", "Japan"], 2);
    const S = await f.match(T, { team_a_id: st.teams[0].id, team_b_id: st.teams[1].id, court_id: c1, group_id: st.groupId, match_order: 1 });
    const D = await f.match(T, { team_a_id: dt.teams[0].id, team_b_id: dt.teams[1].id, court_id: c2, group_id: dt.groupId, match_order: 2 });

    // A chair umpire for Court 1 (code + PIN) and a master referee.
    const sara = await refereeWithPin(MB, `Sara V2 ${tag}`);
    const omar = await refereeWithPin(MB, `Omar V2 ${tag}`);
    await db().from("referees").update({ role: "master_referee" }).eq("id", omar.id);
    const courtCode = generateEventCode();
    const masterCode = generateEventCode();
    const { data: cr, error: ce } = await db()
      .from("organization_codes")
      .insert([
        { organization_id: MB, role: "referee", tournament_id: T, court_name: "Court 1", code_hash: hashEventCode(courtCode), label: `e2e v2 court ${tag}` },
        { organization_id: MB, role: "master_referee", tournament_id: T, referee_id: omar.id, code_hash: hashEventCode(masterCode), label: `e2e v2 master ${tag}` },
      ])
      .select("id");
    if (ce) throw new Error(`organization_codes: ${ce.message}`);
    codes.push(...((cr ?? []) as { id: string }[]).map((r) => r.id));
    const refIn = await http("POST", SESSION, ip(71), { code: courtCode, pin: sara.pin });
    const masterIn = await http("POST", SESSION, ip(72), { code: masterCode, pin: omar.pin });
    check(refIn.status === 200 && masterIn.status === 200, "a chair umpire (Court 1) and a master referee sign in with their PINs", { ref: refIn.json?.error, master: masterIn.json?.error });
    const REF = bearer(String(refIn.json?.token));
    const MASTER = bearer(String(masterIn.json?.token));

    /* ---------------- settings reach the console ---------------- */
    section("The organiser's scoring features reach the console through the referee bootstrap");
    const boot = await http("GET", `/api/mobile/v1/referee/matches/${S.id}/bootstrap`, REF);
    const feats = (boot.json?.matchDay as { features?: Record<string, boolean> } | undefined)?.features;
    check(boot.status === 200 && JSON.stringify(feats) === JSON.stringify(SCORING_FEATURES_ON), "a new tournament has every v2 feature on, in the bootstrap", feats);
    const config = boot.json?.config as ScoringConfig;

    /* ---------------- singles ---------------- */
    section("Singles through the events API (chair umpire): faults, double fault, aces, lets, changeover, rulings, a bathroom break");
    const claim = await http("POST", `/api/matches/${S.id}/claim`, REF, { deviceId: `v2-ref-${tag}`, deviceLabel: "Court 1 phone" });
    check(claim.status === 200 && claim.json?.controller === true, "the referee's phone takes the match", claim.json);
    const s = new Scorer(S.id, REF, `v2-ref-${tag}`, { A: st.teams[0].id, B: st.teams[1].id }, config, false);
    let r = await s.step(() => C.startMatch("A"));
    // L5: a singles match has no serve and receive order, whatever a console sends.
    const singlesOrder = await s.refused((x) => C.serveOrderEvent(x, { servingTeam: "A", server: 0, receiver: 0, otherServer: 0, otherReceiver: 0 }));
    check(singlesOrder.status === 409 && singlesOrder.json?.conflict === "state_mismatch" && (singlesOrder.json?.applied as unknown[])?.length === 0, "L5: a SERVE_ORDER in singles: 409 state_mismatch, nothing applied", singlesOrder.json);
    r = await s.step((x) => C.faultEvent(x, s.opts));
    let snap = await snapshotOf(S.id);
    check(r.status === 200 && serveNumber(snap) === 2 && snap.teamA.points === "0", "FAULT: the server's state is on the 2nd serve, score unchanged", { status: r.status, err: r.json?.error });
    r = await s.step((x) => C.letEvent(x, "serve"));
    snap = await snapshotOf(S.id);
    check(r.status === 200 && serveNumber(snap) === 2, "LET (serve let): still the 2nd serve", r.json?.error);
    r = await s.step((x) => C.faultEvent(x, s.opts));
    snap = await snapshotOf(S.id);
    check(r.status === 200 && snap.teamB.points === "15" && snap.stats?.doubleFaults.A === 1 && serveNumber(snap) === 1, "second FAULT = double fault: 0-15, counted, back to the 1st serve", { points: [snap.teamA.points, snap.teamB.points], stats: snap.stats });
    const { data: dfRow } = await db().from("score_events").select("event_type, team_id, note").eq("match_id", S.id).eq("event_number", 4).single();
    check((dfRow as { event_type: string })?.event_type === "POINT_AWARDED" && (dfRow as { team_id: string }).team_id === st.teams[1].id && /double_fault/.test(String((dfRow as { note: string }).note)), "the double fault is stored as a point to the receiver, marked double_fault", dfRow);
    r = await s.step((x) => C.aceEvent(x, s.opts));
    snap = await snapshotOf(S.id);
    check(r.status === 200 && snap.teamA.points === "15" && snap.stats?.aces.A === 1, "ACE: a point to the server, counted", snap.stats);
    // The app's match page and the TV read the ACE moment and the count.
    // The app's reads are memoised for a moment (0.8 s match, 1.5 s live feed).
    await sleep(1600);
    const detail = await http("GET", `/api/mobile/v1/matches/${S.id}`);
    const score = (detail.json?.match as { score?: { aces?: { a: number; b: number }; ace?: boolean } } | undefined)?.score;
    check(detail.status === 200 && score?.ace === true && score.aces?.a === 1, "the app's match payload: ace true and aces {a: 1}", score);
    const live = await http("GET", `/api/t/${slug}/live`);
    const liveState = ((live.json?.snapshots ?? []) as { match_id: string; state?: ScoreState }[]).find((x) => x.match_id === S.id)?.state;
    const rules = matchDayRules((await db().from("tournaments").select("match_day_rules, sport").eq("id", T).single()).data?.match_day_rules, "tennis").features;
    const tvOn = { aces: rules.tvAces && rules.ace, timers: rules.tvTimers };
    check(tvExtras(liveState, Date.now(), tvOn).ace === true, "the court TV's feed state shows the ACE moment", liveState?.lastAce);
    r = await s.step((x) => C.faultEvent(x, s.opts));
    r = await s.step((x) => C.letEvent(x, "point"));
    snap = await snapshotOf(S.id);
    check(r.status === 200 && serveNumber(snap) === 1 && snap.teamA.points === "15", "LET (replay point): back to the 1st serve, score unchanged", { serve: snap.serve, points: snap.teamA.points });
    // Doctored states are refused before anything is stored.
    const forged = s.build(C.aceEvent(s.state!, s.opts));
    (forged.new_state as ScoreState).stats = { aces: { A: 9, B: 0 }, doubleFaults: { A: 0, B: 0 } };
    s.n--;
    s.state = forged.previous_state;
    s.sent.pop();
    r = await s.send(forged);
    check(r.status === 409 && r.json?.conflict === "state_mismatch" && (r.json?.applied as unknown[])?.length === 0, "an ace with a doctored count: 409 state_mismatch, nothing applied", r.json);
    const wrongSide = s.build(C.point(s.state!, "B", s.opts));
    wrongSide.payload = { ace: true };
    s.n--;
    s.state = wrongSide.previous_state;
    s.sent.pop();
    r = await s.send(wrongSide);
    check(r.status === 409 && r.json?.conflict === "state_mismatch", "an 'ace' scored for the receiver: refused", r.json?.error);
    // M2: the server re-derives a v2 event from its previous_state, so that must be the server's own
    // score. An ace from a score the device made up (40-15), consistent with itself, is refused.
    {
      const real = s.state!;
      const claimed: ScoreState = { ...real, teamA: { ...real.teamA, points: "40" } };
      const madeUp = s.build(C.aceEvent(claimed, s.opts));
      madeUp.previous_state = claimed;
      s.n--;
      s.state = real;
      s.sent.pop();
      r = await s.send(madeUp);
      snap = await snapshotOf(S.id);
      check(r.status === 409 && r.json?.conflict === "stale_state" && (r.json?.applied as unknown[])?.length === 0 && snap.teamA.points === real.teamA.points, "M2: an ace whose previous_state is not the server's score: 409 stale_state, nothing applied", { status: r.status, body: r.json });
      // Inside a batch: a LET that follows on, then an ace from somewhere else. The LET stands.
      const letOk = s.build(C.letEvent(s.state!, "point"));
      const afterLet = s.state!;
      const elsewhere: ScoreState = { ...afterLet, teamB: { ...afterLet.teamB, games: 4 } };
      const broken = s.build(C.aceEvent(elsewhere, s.opts));
      broken.previous_state = elsewhere;
      s.n--;
      s.state = afterLet;
      s.sent.pop();
      r = await s.send(letOk, broken);
      const applied = (r.json?.applied ?? []) as string[];
      check(r.status === 409 && r.json?.conflict === "stale_state" && applied.length === 1 && applied[0] === letOk.client_event_id && r.json?.last_event_number === letOk.event_number, "M2: a break in the chain inside a batch: the events before it are kept, the rest refused (stale_state)", r.json);
    }
    // Play on to 2-1 in games: a changeover.
    for (let i = 0; i < 3; i++) await s.step((x) => C.aceEvent(x, s.opts)); // 40-15, then game Egypt
    for (let i = 0; i < 4; i++) await s.step((x) => C.point(x, "B", s.opts)); // game USA
    let last: C.ConsoleEvent | null = null;
    for (let i = 0; i < 4; i++) {
      last = C.point(s.state!, "A", s.opts);
      r = await s.send(s.build(last));
    }
    check(last?.after?.timer === "changeover" && last.after.changeEnds, "after game 3 the console starts the 1:30 changeover (ITF Rule 29a)", last?.after);
    const started = new Date(Date.now() - 95_000).toISOString();
    r = await s.step((x) => C.timerStart(x, "changeover", started));
    check(r.status === 200, "TIMER_STARTED (changeover) accepted", r.json?.error);
    await sleep(1600);
    const det2 = await http("GET", `/api/mobile/v1/matches/${S.id}`);
    const clock = (det2.json?.match as { score?: { clock?: { kind: string; startedAt: string } } } | undefined)?.score?.clock;
    check(clock?.kind === "changeover" && clock.startedAt === started, "the app's match payload carries the running changeover", clock);
    const live2 = await http("GET", `/api/t/${slug}/live`);
    const live2State = ((live2.json?.snapshots ?? []) as { match_id: string; state?: ScoreState }[]).find((x) => x.match_id === S.id)?.state;
    const tvClock = tvExtras(live2State, Date.now(), tvOn).clock;
    check(tvClock?.label === "Changeover" && tvClock.over === true && /^1:3\d$/.test(tvClock.text), "the court TV shows 'Changeover 1:3x', over the limit", tvClock);
    r = await s.step((x) => C.timeDecision(x, "changeover", "code_violation", 95, "B"));
    r = await s.step((x) => C.timerStop(x, "changeover", 95));
    r = await s.step((x) => C.violation(x, "B", "time", s.opts));
    snap = await snapshotOf(S.id);
    check(r.status === 200 && snap.violations?.[0]?.offence === "time" && snap.violations[0].penalty === "warning" && !snap.clock, "overrun ruled a code violation: TIME_DECISION, the timer stopped, CODE_VIOLATION (time, warning)", snap.violations);
    await sleep(900);
    const det3 = await http("GET", `/api/mobile/v1/matches/${S.id}`);
    check((det3.json?.match as { score?: { clock?: unknown } } | undefined)?.score?.clock == null, "…and the app no longer shows a timer", (det3.json?.match as { score?: unknown })?.score);
    r = await s.step((x) => C.timerStart(x, "bathroom", new Date().toISOString(), "B"));
    r = await s.step((x) => C.timerStop(x, "bathroom", 125, "B"));
    check(r.status === 200, "a bathroom break for USA, started and stopped", r.json?.error);
    // L9: a break is running and the next point is scored without stopping it (a console that
    // does not stop it first): the point closes it in the state, and Undo never brings it back.
    r = await s.step((x) => C.timerStart(x, "break", new Date(Date.now() - 20_000).toISOString()));
    snap = await snapshotOf(S.id);
    check(r.status === 200 && snap.clock?.kind === "break" && tvExtras(snap, Date.now(), tvOn).clock?.label === "Break", "L9: a break running on the court TV", snap.clock);
    r = await s.step((x) => C.point(x, "A", s.opts));
    snap = await snapshotOf(S.id);
    check(r.status === 200 && !snap.clock, "L9: the next point closes the running break in the state", snap.clock);
    // Undo takes back that point, never a timer.
    const bootU = await http("GET", `/api/mobile/v1/referee/matches/${S.id}/bootstrap`, REF);
    const hist = (bootU.json?.history ?? []) as ScoreState[];
    check(hist.length > 0 && hist.every((h) => !h.clock), "L9: the bootstrap's undo history carries no running timer", hist.at(-1)?.clock);
    r = await s.send(s.build(C.undo(hist, false)));
    snap = await snapshotOf(S.id);
    check(r.status === 200 && snap.teamA.points === "0" && snap.teamA.games === 2, "UNDO takes back the last point (the history the bootstrap sends skips timers)", { points: snap.teamA.points, games: snap.teamA.games });
    check(!snap.clock && tvExtras(snap, Date.now(), tvOn).clock === null, "L9: after the Undo the court TV shows no timer (the old break is not resurrected)", snap.clock);
    // Finish with aces.
    let guard = 0;
    while (!s.state!.matchOver && guard++ < 200) {
      // Egypt's aces on Egypt's serve, plain points for Egypt otherwise.
      const e = currentServer(s.state!) === "A" ? C.aceEvent(s.state!, s.opts) : C.point(s.state!, "A", s.opts);
      r = await s.send(s.build(e));
      if (r.status !== 200) {
        console.log("finishing stopped", r.status, r.json);
        break;
      }
    }
    if (!s.state!.matchOver) console.log("not over after", guard, JSON.stringify(s.state).slice(0, 400));
    const sRow = (await db().from("matches").select("status, winner_team_id").eq("id", S.id).single()).data as { status: string; winner_team_id: string } | null;
    check(sRow?.status === "completed" && sRow.winner_team_id === st.teams[0].id, "the match finishes (aces on Egypt's serve): completed, Egypt", sRow);
    const timerAfter = await s.refused((x) => C.timerStart(x, "break", new Date().toISOString()));
    check(timerAfter.status === 409 && timerAfter.json?.conflict === "finished", "a timer after the match is over: refused as finished", timerAfter.json);

    /* ---------------- the match log ---------------- */
    section("The match log: the referee, the master referee and the organiser");
    const logR = await http("GET", `/api/matches/${S.id}/log`, REF);
    const entries = (logR.json?.entries ?? []) as { n: number; tag: string; by: string | null; undone: boolean; title: string; detail: string }[];
    check(logR.status === 200 && entries.length === s.n, `the referee reads every event in order (${entries.length} of ${s.n})`, logR.json?.error);
    const tags = new Set(entries.map((e) => e.tag));
    check(["fault", "double_fault", "ace", "let", "point", "timer", "time_ruling", "violation", "undo", "status"].every((t) => tags.has(t)), "faults, a double fault, aces, lets, points, timers, a ruling, a violation, an undo", [...tags]);
    check(entries.every((e) => e.by?.includes(`Sara V2 ${tag}`)), "every row names who entered it (the referee's name)", entries[0]?.by);
    check(entries.some((e) => e.undone && e.tag === "point"), "the point taken back is marked undone", entries.filter((e) => e.undone));
    check(entries.some((e) => /Set 1 · Game 1 · 0–0 · 0–15/.test(e.title) && e.tag === "double_fault"), "rows carry the score after the event (Set 1 · Game 1 · 0–0 · 0–15)", entries.find((e) => e.tag === "double_fault"));
    const logM = await http("GET", `/api/matches/${S.id}/log`, MASTER);
    check(logM.status === 200 && ((logM.json?.entries ?? []) as unknown[]).length === s.n, "the master referee reads it", logM.status);
    const logA = await http("GET", `/api/matches/${S.id}/log`, ADMIN);
    check(logA.status === 200, "the organiser reads it", logA.status);
    const adminPage = await http("GET", `/admin/tournaments/${T}/matches/${S.id}/log`, ADMIN);
    check(adminPage.status === 200 && adminPage.text.includes('data-testid="admin-match-log"') && adminPage.text.includes("double fault"), "the admin match log page", adminPage.status);
    const anon = await http("GET", `/api/matches/${S.id}/log`);
    check(anon.status === 401, "nobody signed out", anon.status);

    /* ---------------- L4: a court code and a finished match ---------------- */
    section("L4: the chair umpire's code changes a finished match only within 30 minutes of its end; the master referee still can");
    {
      const historyOf = async () => ((await http("GET", `/api/mobile/v1/referee/matches/${S.id}/bootstrap`, ADMIN)).json?.history ?? []) as ScoreState[];
      const rowOf = async () => (await db().from("matches").select("status, ended_at").eq("id", S.id).single()).data as { status: string; ended_at: string | null } | null;
      await db().from("matches").update({ ended_at: new Date(Date.now() - 5 * 60_000).toISOString() }).eq("id", S.id);
      let h = await historyOf();
      r = await s.step(() => C.undo(h, true));
      check(r.status === 200 && (await rowOf())?.status === "live", "5 minutes after the end: the chair umpire's Undo reopens the match", { status: r.status, body: r.json });
      r = await s.send(s.build(C.point(s.state!, "A", s.opts)));
      check(r.status === 200 && (await rowOf())?.status === "completed", "…and the winning point finishes it again", { status: r.status, body: r.json });
      await db().from("matches").update({ ended_at: new Date(Date.now() - 31 * 60_000).toISOString() }).eq("id", S.id);
      h = await historyOf();
      const locked = await s.refused(() => C.undo(h, true));
      check(locked.status === 409 && locked.json?.conflict === "finished_locked" && (locked.json?.applied as unknown[])?.length === 0 && (await rowOf())?.status === "completed", "31 minutes after the end: the chair umpire's Undo is refused (409 finished_locked), the match stays completed", locked.json);
      const master = new Scorer(S.id, MASTER, `v2-ref-${tag}`, { A: st.teams[0].id, B: st.teams[1].id }, config, false);
      master.state = s.state;
      master.n = s.n;
      r = await master.step(() => C.undo(h, true));
      check(r.status === 200 && (await rowOf())?.status === "live", "the master referee's code still reopens it", { status: r.status, body: r.json });
    }

    /* ---------------- doubles ---------------- */
    section("Doubles (admin's console): the serve and receive order at every set, the rotation followed by the server's state");
    await http("POST", `/api/matches/${D.id}/claim`, ADMIN, { deviceId: `v2-admin-${tag}` });
    const dboot = await http("GET", `/api/mobile/v1/referee/matches/${D.id}/bootstrap`, ADMIN);
    const d = new Scorer(D.id, ADMIN, `v2-admin-${tag}`, { A: dt.teams[0].id, B: dt.teams[1].id }, dboot.json?.config as ScoringConfig, true);
    await d.step(() => C.startMatch("A"));
    r = await d.step((x) => C.serveOrderEvent(x, { servingTeam: "B", server: 1, receiver: 0, otherServer: 1, otherReceiver: 1 }));
    let ds = await snapshotOf(D.id);
    check(r.status === 200 && ds.servingTeam === "B" && ds.orderSet === 1, "SERVE_ORDER for set 1: Japan serve first", { status: r.status, err: r.json?.error, serving: ds.servingTeam });
    check(JSON.stringify(servingPlayer(ds)) === JSON.stringify({ team: "B", index: 1 }) && JSON.stringify(receivingPlayer(ds)) === JSON.stringify({ team: "A", index: 0, court: "deuce" }), "server: Japan's 2nd player; receiver: Spain's 1st player (deuce court)", { srv: servingPlayer(ds), rcv: receivingPlayer(ds) });
    await d.step((x) => C.point(x, "B", d.opts));
    ds = await snapshotOf(D.id);
    check(JSON.stringify(receivingPlayer(ds)) === JSON.stringify({ team: "A", index: 1, court: "ad" }), "next point: Spain's 2nd player receives in the ad court", receivingPlayer(ds));
    const mid = await d.refused((x) => C.serveOrderEvent({ ...x, teamA: { ...x.teamA, points: "0" }, teamB: { ...x.teamB, points: "0" } }, { servingTeam: "A", server: 0, receiver: 0, otherServer: 0, otherReceiver: 0 }));
    check(mid.status === 409 && mid.json?.conflict === "state_mismatch", "a serve order in the middle of a set: refused", mid.json?.error);
    for (let i = 0; i < 3; i++) await d.step((x) => C.point(x, "B", d.opts));
    ds = await snapshotOf(D.id);
    check(JSON.stringify(servingPlayer(ds)) === JSON.stringify({ team: "A", index: 1 }) && JSON.stringify(receivingPlayer(ds)) === JSON.stringify({ team: "B", index: 1, court: "deuce" }), "game 2: Spain's chosen server (2nd player); Japan's chosen receiver", { srv: servingPlayer(ds), rcv: receivingPlayer(ds) });
    // Win set 1 for Japan, then the question again.
    while (d.state!.currentSet === 1) await d.send(d.build(C.point(d.state!, "B", d.opts)));
    // 6-0 to Japan, who served game 1: six games, so Japan serves set 2's first game (the rotation).
    check(dueServingTeam(d.state!) === "B" && C.serveOrderEvent(d.state!, { servingTeam: "B", server: 0, receiver: 1, otherServer: 0, otherReceiver: 0 }, true) !== null, "set 2 starts: the console asks again, Japan to serve by the rotation", dueServingTeam(d.state!));
    // The rotation is only offered: the referee may name either team at a set start (owner, 27 Oct 2026).
    check(C.serveOrderEvent(d.state!, { servingTeam: "A", server: 0, receiver: 1, otherServer: 0, otherReceiver: 0 }, true)?.next.servingTeam === "A", "set 2: the referee may name Spain instead of the rotation's Japan");
    r = await d.step((x) => C.serveOrderEvent(x, { servingTeam: "B", server: 0, receiver: 1, otherServer: 0, otherReceiver: 0 }, true));
    ds = await snapshotOf(D.id);
    check(r.status === 200 && ds.orderSet === 2 && ds.servingTeam === "B" && JSON.stringify(servingPlayer(ds)) === JSON.stringify({ team: "B", index: 0 }) && JSON.stringify(receivingPlayer(ds)) === JSON.stringify({ team: "A", index: 1, court: "deuce" }), "SERVE_ORDER for set 2 stored and followed", { srv: servingPlayer(ds), rcv: receivingPlayer(ds) });

    /* ---------------- settings: admins only; switched off = refused and hidden ---------------- */
    section("Admin → Scoring features: admins only; a switched-off feature is refused and hidden");
    const page = await http("GET", `/admin/tournaments/${T}/scoring-features`, ADMIN);
    check(page.status === 200 && page.text.includes('data-testid="scoring-features"') && page.text.includes("Only admins can change these"), "the admin tab", page.status);
    const mpage = await http("GET", `/admin/tournaments/${T}/scoring-features`, MANAGER);
    check(mpage.status === 200 && mpage.text.includes("Read-only"), "a manager sees it read-only", mpage.status);
    const rpage = await http("GET", `/admin/tournaments/${T}/scoring-features`, REF);
    check(rpage.status !== 200 || !rpage.text.includes('data-testid="scoring-features"'), "a referee never reaches it", rpage.status);
    const off = form({ tournament_id: T, intent: "save", ...Object.fromEntries(Object.keys(SCORING_FEATURES_ON).filter((k) => !["fault", "matchLog", "tvAces"].includes(k)).map((k) => [k, "on"])) });
    const byManager = await callAction("src/app/admin/tournaments/[id]/scoring-features/actions.ts", "saveScoringFeatures", [off], MANAGER, { id: T });
    let stored = (await db().from("tournaments").select("match_day_rules").eq("id", T).single()).data?.match_day_rules as { features?: Record<string, boolean> };
    check(!actionOk(byManager) && stored.features?.fault !== false, "a manager cannot change them", byManager.status);
    const byMaster = await callAction("src/app/admin/tournaments/[id]/scoring-features/actions.ts", "saveScoringFeatures", [off], MASTER, { id: T });
    check(!actionOk(byMaster), "a master referee cannot change them", byMaster.status);
    const byAdmin = await callAction("src/app/admin/tournaments/[id]/scoring-features/actions.ts", "saveScoringFeatures", [off], ADMIN, { id: T });
    stored = (await db().from("tournaments").select("match_day_rules").eq("id", T).single()).data?.match_day_rules as { features?: Record<string, boolean> };
    check(actionOk(byAdmin) && stored.features?.fault === false && stored.features.matchLog === false && stored.features.ace === true, "an admin switches Fault, the referees' match log and aces on TV off", stored.features);
    const mdSave = await callAction("src/app/admin/tournaments/[id]/match-day/actions.ts", "saveMatchDayRules", [form({ tournament_id: T, intent: "defaults" })], ADMIN, { id: T });
    stored = (await db().from("tournaments").select("match_day_rules").eq("id", T).single()).data?.match_day_rules as { features?: Record<string, boolean> };
    check(actionOk(mdSave) && stored.features?.fault === false, "saving the Match day tab keeps the scoring features", stored.features);
    const boot2 = await http("GET", `/api/mobile/v1/referee/matches/${D.id}/bootstrap`, ADMIN);
    const f2 = (boot2.json?.matchDay as { features?: Record<string, boolean> } | undefined)?.features;
    check(f2?.fault === false && f2.ace === true && f2.matchLog === false, "the console is told (bootstrap): Fault hidden, Ace still there", f2);
    const faultOff = await d.refused((x) => C.faultEvent(x, d.opts));
    check(faultOff.status === 409 && faultOff.json?.conflict === "feature_off", "a FAULT now: 409 feature_off", faultOff.json?.error);
    const dfOff = await d.refused((x) => C.faultEvent({ ...x, serve: { fault: 1, at: scoreKey(x) } }, d.opts));
    check(dfOff.status === 409, "a double fault too (it is the Fault feature)", dfOff.json?.conflict);
    r = await d.step((x) => C.aceEvent(x, d.opts));
    check(r.status === 200, "an ACE still goes in", r.json?.error);
    await sleep(900);
    const det4 = await http("GET", `/api/mobile/v1/matches/${D.id}`);
    const sc4 = (det4.json?.match as { score?: { aces?: unknown; ace?: unknown } } | undefined)?.score;
    check(det4.status === 200 && Boolean(sc4) && sc4 !== undefined && !("aces" in sc4) && !("ace" in sc4), "aces on TV & app off: the app's payload has no aces", sc4);
    const logOff = await http("GET", `/api/matches/${S.id}/log`, REF);
    const logOffAdmin = await http("GET", `/api/matches/${S.id}/log`, ADMIN);
    check(logOff.status === 403 && logOffAdmin.status === 200, "match log off: a referee is refused (403), the organiser still reads it", { ref: logOff.status, admin: logOffAdmin.status });
    const plain = await d.step((x) => C.point(x, "A", d.opts));
    check(plain.status === 200, "plain points (and Move Score 1.0.1) are never affected", plain.json?.error);

    if (keep) {
      console.log(`\nKEEP=1: tournament ${T} (${slug}); singles ${S.id}; doubles ${D.id}; court code ${courtCode} PIN ${sara.pin}; master code ${masterCode} PIN ${omar.pin}`);
      // The features back on for screenshots.
      await db().from("tournaments").update({ match_day_rules: { ...(stored as object), features: SCORING_FEATURES_ON } }).eq("id", T);
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
  finish("Scoring v2");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
