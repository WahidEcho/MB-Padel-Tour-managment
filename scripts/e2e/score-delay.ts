/**
 * The audience delay ("delay meter", stand-in only): the organiser sets the score
 * delay on Admin → In the app (bad input refused, another organisation cannot,
 * the change audited); with 0 a point shows on the public app API at once; with
 * 6 s a new point is not on the public app API (match, live feed, timeline,
 * stats) but is on the referee's state and the venue TV feed at once, and reaches
 * the public a few seconds later; a match finished inside the window still reads
 * live with no winner on the app API and the public website (and the group table
 * keeps the pre-result view), its "match finished" alert is queued for later; the
 * live feed and the website say the scores are behind; back to 0 is live again.
 *
 *   LOCALDB_PORT=54411 npm run localdb                   # terminal 1
 *   npm run build && (set -a; . ./.env.localdb; set +a; SUPABASE_URL=http://localhost:54411 \
 *     PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1 npx next start -p 3111)   # terminal 2
 *   SUPABASE_URL=http://localhost:54411 BASE_URL=http://localhost:3111 npm run e2e:score-delay   # terminal 3
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { awardPoint, initialScoreState, type ScoreState } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import type { Match, Tournament } from "../../src/lib/types";
import { actionOk, callAction, form } from "./lib/actions";
import { appUser, assertStandIn, check, cookie, finish, fixtures, http, scoreEvent, section, sendEvents, sleep, staff, type Who } from "./lib/fixtures";
import { staffToken } from "./lib/session";

const ADMIN = staff("admin");
const ACTIONS = "src/app/admin/tournaments/[id]/app/actions.ts";
const DELAY = 6;
const refused = (r: { status: number; text: string }) => !actionOk(r) || /"ok":false/.test(r.text);

/** Retries `fn` until it stops throwing, or rethrows its last error after `ms`. */
async function eventually<T>(fn: () => Promise<T>, ms: number, every = 250): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > until) throw e;
      await sleep(every);
    }
  }
}

interface PublicMatch {
  status: string;
  winner: string | null;
  score: { points: { a: string; b: string } | null; lastEventNumber: number } | null;
}

async function main() {
  assertStandIn("score-delay");
  for (const prefix of ["staff-", "devices"]) await db().from("request_counters").delete().like("bucket_key", `${prefix}%`);
  const tag = randomUUID().slice(0, 6);
  const f = fixtures(tag);
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;
  let T = "";

  try {
    T = await f.tournament({ name: "Score Delay" });
    await db().from("tournaments").update({ public_access_enabled: true, organization_id: MB, is_demo: false }).eq("id", T);
    const { data: trow } = await db().from("tournaments").select("*").eq("id", T).single();
    const tournament = trow as Tournament;
    const slug = tournament.slug;
    const [court] = await f.courts(T, 1);
    const nat = await f.teams(T, ["Alpha", "Bravo"], 2);
    const [A, B] = nat.teams;
    const match = await f.match(T, { team_a_id: A.id, team_b_id: B.id, court_id: court, group_id: nat.groupId, match_order: 1 });
    const rules = scoringConfigForMatch(tournament, match as Match);

    // A referee's tablet: ordered events through the real events route.
    const device = `e2e-delay-${tag}`;
    let n = 0;
    let state: ScoreState = initialScoreState("A");
    const send = async (type: string, next: ScoreState, extra: { team_id?: string | null; payload?: Record<string, unknown> } = {}) => {
      n++;
      const r = await sendEvents(match.id, ADMIN, [scoreEvent(n, type, n === 1 ? null : state, next, extra)], device);
      if (r.status !== 200) throw new Error(`${type} refused: ${r.status} ${r.text.slice(0, 200)}`);
      state = next;
    };
    const point = (side: "A" | "B") => send("POINT_AWARDED", awardPoint(state, side, rules), { team_id: side === "A" ? A.id : B.id });
    const publicMatch = async () => (JSON.parse((await http("GET", `/api/mobile/v1/matches/${match.id}`)).text) as { match: PublicMatch }).match;
    const publicLive = async () => JSON.parse((await http("GET", `/api/mobile/v1/t/${slug}/live`)).text) as Record<string, unknown> & { matches: (PublicMatch & { id: string })[]; scoreDelaySeconds?: number };
    const points = (m: PublicMatch | undefined) => (m?.score?.points ? `${m.score.points.a}-${m.score.points.b}` : null);

    section("Admin → In the app → Score delay");
    const save = (who: Who, seconds: string, id = T) => callAction(ACTIONS, "saveScoreDelay", [null, form({ tournament_id: id, seconds })], who, { id });
    const page = await http("GET", `/admin/tournaments/${T}/app`, ADMIN);
    check(page.status === 200 && page.text.includes("Score delay") && page.text.includes("score-delay-range") && page.text.includes("Off · live"), "The In the app tab has the delay meter (slider + seconds), off", page.status);
    for (const bad of ["abc", "121", "-5", "2.5"]) {
      const r = await save(ADMIN, bad);
      check(refused(r) && /whole seconds from 0 to 120/.test(r.text), `"${bad}" is refused with the reason`, r.text.slice(0, 120));
    }
    const zero = await save(ADMIN, "0");
    check(actionOk(zero) && /"ok":true/.test(zero.text) && /Off/.test(zero.text), "0 (off) is saved", zero.text.slice(0, 160));

    section("Delay off: a point is public at once");
    await send("MATCH_STARTED", initialScoreState("A"));
    await point("A");
    const at0 = await eventually(async () => {
      const m = await publicMatch();
      if (points(m) !== "15-0") throw new Error(String(points(m)));
      return m;
    }, 4000);
    check(at0.status === "live" && points(at0) === "15-0", "The public match shows 15-0 right away", points(at0));
    const live0 = await publicLive();
    check(live0.scoreDelaySeconds === undefined, "The live feed carries no scoreDelaySeconds while it is off");

    section(`Delay ${DELAY} s`);
    const on = await save(ADMIN, String(DELAY));
    check(actionOk(on) && /"ok":true/.test(on.text) && new RegExp(`${DELAY} s after the referee`).test(on.text), `${DELAY} s is saved`, on.text.slice(0, 160));
    const { data: stored } = await db().from("tournaments").select("branding_config").eq("id", T).single();
    const cfg = (stored as { branding_config: { scoreDelay?: { seconds: number } } }).branding_config.scoreDelay;
    check(cfg?.seconds === DELAY, "Stored in branding_config.scoreDelay (no migration)", cfg);
    const { count: audits } = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("tournament_id", T).eq("action", "SCORE_DELAY_SET");
    check((audits ?? 0) === 2, "Each change is audited", audits);
    const adminPage = await http("GET", `/admin/tournaments/${T}/app`, ADMIN);
    check(adminPage.text.includes(`${DELAY} s behind live`), "The tab shows the delay that is on");
    // Each server keeps a tournament's delay for a few seconds (the alerts read it), and the 15-0
    // must be older than the delay: wait a little longer than both.
    await sleep(DELAY * 1000 + 1500);
    const before = await publicMatch();
    check(before.status === "live" && points(before) === "15-0", "With the delay on, the earlier point (older than the delay) is still shown", points(before));

    await point("A");
    const scoredAt = Date.now();
    const [pubNow, liveNow, refNow, tvNow, timeline, stats] = await Promise.all([
      publicMatch(),
      publicLive(),
      http("GET", `/api/matches/${match.id}/state`, ADMIN),
      http("GET", `/api/t/${slug}/live?screen=main`),
      http("GET", `/api/mobile/v1/matches/${match.id}/timeline`),
      http("GET", `/api/mobile/v1/matches/${match.id}/stats`),
    ]);
    check(Date.now() - scoredAt < DELAY * 1000 - 1000, "(the reads ran inside the window)", Date.now() - scoredAt);
    check(points(pubNow) === "15-0", "The new point is not on the public match yet (still 15-0)", points(pubNow));
    const inFeed = liveNow.matches.find((m) => m.id === match.id);
    check(points(inFeed) === "15-0" && liveNow.scoreDelaySeconds === DELAY, `The public live feed still shows 15-0 and says scoreDelaySeconds: ${DELAY}`, { p: points(inFeed), d: liveNow.scoreDelaySeconds });
    check(["generatedAt", "tournamentId", "bundleVersion", "ties", "matches", "announcements"].every((k) => k in liveNow), "Every field 1.0.1 reads is still on the live feed");
    const refSnap = (refNow.json as { snapshot: { team_a_point_label: string; last_event_number: number } } | null)?.snapshot;
    check(refSnap?.team_a_point_label === "30" && refSnap.last_event_number === n, "The referee's state has it at once (30-0)", refSnap);
    const tvSnap = ((tvNow.json as { snapshots?: { match_id: string; points: [string, string] }[] } | null)?.snapshots ?? []).find((s) => s.match_id === match.id);
    check(tvNow.status === 200 && tvSnap?.points?.[0] === "30", "The venue TV feed has it at once (30-0)", tvSnap?.points);
    const tlPoints = ((timeline.json as { points?: unknown[] } | null)?.points ?? []).length;
    check(timeline.status === 200 && tlPoints === 1, "The timeline leaves out the point inside the window (1 point, not 2)", tlPoints);
    const statPoints = (stats.json as { stats?: { points?: number } } | null)?.stats?.points;
    check(stats.status === 200 && statPoints === 1, "The stats leave it out too (1 point played)", stats.json?.stats);

    const after = await eventually(async () => {
      const m = await publicMatch();
      if (points(m) !== "30-0") throw new Error(String(points(m)));
      return m;
    }, (DELAY + 6) * 1000, 500);
    const shownAfter = Date.now() - scoredAt;
    check(points(after) === "30-0" && shownAfter >= DELAY * 1000 - 500, `The point reaches the public about ${DELAY} s later (${(shownAfter / 1000).toFixed(1)} s)`, shownAfter);

    section("A match started inside the window is not started yet");
    const second = await f.match(T, { team_a_id: B.id, team_b_id: A.id, court_id: court, group_id: nat.groupId, match_order: 2 });
    const s2 = initialScoreState("A");
    const started = await sendEvents(second.id, ADMIN, [scoreEvent(1, "MATCH_STARTED", null, s2), scoreEvent(2, "POINT_AWARDED", s2, awardPoint(s2, "A", rules), { team_id: B.id })], `${device}-2`);
    check(started.status === 200, "A second match starts and scores (its referee)", started.status);
    const secondNow = (JSON.parse((await http("GET", `/api/mobile/v1/matches/${second.id}`)).text) as { match: PublicMatch }).match;
    check(secondNow.status === "scheduled" && secondNow.score === null, "The public sees it as not started, with no score", { s: secondNow.status, score: secondNow.score });
    const secondLater = await eventually(async () => {
      const m = (JSON.parse((await http("GET", `/api/mobile/v1/matches/${second.id}`)).text) as { match: PublicMatch }).match;
      if (m.status !== "live") throw new Error(m.status);
      return m;
    }, (DELAY + 6) * 1000, 500);
    check(points(secondLater) === "15-0", "…and live at 15-0 once the delay has passed", points(secondLater));

    section("A match finished inside the window still reads live");
    await send("FORCE_END", { ...state, matchOver: true, winner: "A" }, { payload: { winner_team_id: A.id } });
    const endedAt = Date.now();
    const { data: realRow } = await db().from("matches").select("status, winner_team_id").eq("id", match.id).single();
    check((realRow as { status: string }).status === "completed", "The match is finished in the database", realRow);
    const [pubEnd, liveEnd, standingsEnd, webLive, webTop] = await Promise.all([
      publicMatch(),
      publicLive(),
      http("GET", `/api/mobile/v1/t/${slug}/standings`),
      http("GET", `/t/${slug}/live`),
      http("GET", `/t/${slug}`),
    ]);
    check(Date.now() - endedAt < DELAY * 1000 - 1000, "(the reads ran inside the window)", Date.now() - endedAt);
    check(pubEnd.status === "live" && pubEnd.winner === null, "The public match is still live with no winner", { s: pubEnd.status, w: pubEnd.winner });
    const feedEnd = liveEnd.matches.find((m) => m.id === match.id);
    check(feedEnd?.status === "live" && feedEnd.winner === null, "The public live feed: live, no winner", feedEnd?.status);
    const rowsEnd = ((standingsEnd.json as { groups?: { rows: { teamId: string; won: number }[] }[] } | null)?.groups ?? []).flatMap((g) => g.rows);
    check(rowsEnd.every((r) => r.won === 0), "The group table keeps the pre-result view (nobody has won yet)", rowsEnd);
    check(webLive.status === 200 && webLive.text.includes("score-delay-note") && webLive.text.includes(`Scores are shown ${DELAY} s behind live.`), "The public website says the scores are behind");
    check(!webLive.text.includes("Recent results"), "The public website's Live page has no result for it yet");
    check(webTop.status === 200 && webTop.text.includes("Live now"), "The public overview still lists it under Live now");
    const { data: alerts } = await db().from("notification_events").select("kind, fire_at, created_at").eq("match_id", match.id);
    const rowsA = (alerts ?? []) as { kind: string; fire_at: string; created_at: string }[];
    const finished = rowsA.find((a) => a.kind === "match_finished");
    const liveAlert = rowsA.find((a) => a.kind === "match_live");
    const lead = finished ? Date.parse(finished.fire_at) - Date.parse(finished.created_at) : NaN;
    check(Boolean(finished) && lead >= (DELAY - 1) * 1000 && lead <= (DELAY + 2) * 1000, `The "match finished" alert is queued ${DELAY} s later`, { lead });
    check(Boolean(liveAlert) && Math.abs(Date.parse(liveAlert!.fire_at) - Date.parse(liveAlert!.created_at)) < 1500, `The "match live" alert (sent with the delay off) went at once`);

    const done = await eventually(async () => {
      const m = await publicMatch();
      if (m.status !== "completed") throw new Error(m.status);
      return m;
    }, (DELAY + 6) * 1000, 500);
    check(done.winner === A.id, "After the delay the public match is finished, with its winner");
    const tableDone = await eventually(async () => {
      const s = await http("GET", `/api/mobile/v1/t/${slug}/standings`);
      const rows = ((s.json as { groups?: { rows: { teamId: string; won: number }[] }[] } | null)?.groups ?? []).flatMap((g) => g.rows);
      if (!rows.some((r) => r.won === 1)) throw new Error("no win yet");
      return rows;
    }, 12_000, 1000);
    check(tableDone.find((r) => r.teamId === A.id)?.won === 1, "…and the group table counts the win");

    section("Another organisation cannot set it");
    const { data: o } = await db().from("organizations").insert({ slug: `e2e-sd-x-${tag}`, name: `E2E Score Delay Other ${tag}`, status: "approved" }).select("id").single();
    const X = (o as { id: string }).id;
    f.created.orgs.push(X);
    const xUser = await appUser(`e2e.sd.x.${tag}@example.com`);
    await db().from("organization_members").insert({ organization_id: X, auth_user_id: xUser.userId, invited_email: `e2e.sd.x.${tag}@example.com`, role: "admin", status: "active" });
    const XADMIN = cookie(staffToken({ kind: "member", userId: xUser.userId, orgId: X, role: "admin" }));
    const xSave = await save(XADMIN, "90");
    const { data: still } = await db().from("tournaments").select("branding_config").eq("id", T).single();
    check(!actionOk(xSave) && (still as { branding_config: { scoreDelay?: { seconds: number } } }).branding_config.scoreDelay?.seconds === DELAY, "Another organisation's admin is refused and nothing changes", xSave.status);

    section("Back to 0");
    const off = await save(ADMIN, "0");
    check(actionOk(off) && /"ok":true/.test(off.text), "0 is saved");
    const liveOff = await eventually(async () => {
      const l = await publicLive();
      if (l.scoreDelaySeconds !== undefined) throw new Error("still delayed");
      return l;
    }, 8000, 500);
    check(liveOff.scoreDelaySeconds === undefined, "The live feed is live again (no scoreDelaySeconds)");
  } finally {
    await cleanup();
  }
  finish("score-delay");

  async function cleanup() {
    if (T) {
      await db().from("score_events").delete().eq("tournament_id", T);
      await db().from("organization_members").delete().like("invited_email", `e2e.sd.x.${tag}@example.com`);
    }
    const clean = await f.cleanup();
    check(clean, "Every test row is removed");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
