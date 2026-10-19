/**
 * National team coach access (migration 0037), end to end on the stand-in: two tie events
 * of one event group (the Junior Finals' shape: boys and girls, Egypt in both), and
 *   - the admin makes a code for every team of both events in one click (a manager cannot),
 *     the Team coaches page lists them, the printable cards carry a QR of /c#<code>;
 *   - the coach of Egypt boys signs in on two phones (and the web) with the same code and
 *     sees only Egypt boys: its group table, its ties with court and time, its own line-up
 *     once entered, the opponents' players only once a rubber starts, live score and match
 *     log of its own rubbers without referee names, the players' schedule;
 *   - another team's tie / rubber / line-up / log answers 404 exactly like a missing one;
 *     every staff route (referee lists, scoring, line-ups, assistance, match log, admin)
 *     refuses the coach token; coach routes are read only;
 *   - alerts (PUSH_DRY_RUN) to both coach phones: line-up entered (own players only),
 *     started, called to court, finished, tie soon (scheduled);
 *   - revoking the code fails the next request on every device; a new code replaces the old;
 *   - failed sign-ins are braked (atomic, per address), right ones are not counted;
 *   - the QR page /c without the app: download links, never a sign-in by itself; AASA has /c.
 *
 *   npm run localdb                                                     # another terminal
 *   npm run build && PUSH_DRY_RUN=1 npx next start -p 3077              # env from .env.localdb
 *   npm run e2e:coaches
 *
 * Creates and deletes its own data.
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { finalizeMatch, upsertSnapshotFromState } from "../../src/lib/ops";
import { getTournament } from "../../src/lib/data";
import { generateGroupTies, getTies, scheduleTie, setLineup } from "../../src/lib/tennis/tieOps";
import { formatEventCode, hashEventCode, openEventCode } from "../../src/lib/orgs/codes";
import { coachLink, parseCoachLink } from "../../src/lib/coaches/rules";
import { mintInstallToken } from "../../src/lib/mobile/identity";
import { eventDay } from "../../src/lib/matchday/eventDay";
import { zonedToIso } from "../../src/lib/tennis/ties";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Match, type Tie } from "../../src/lib/types";
import { BASE_URL, assertStandIn, bearer, check, eventually, finish, fixtures, http, scoreEvent, section, sendEvents, staff, type Who } from "./lib/fixtures";
import { actionOk, callAction, form } from "./lib/actions";

assertStandIn("coaches");

const tag = randomUUID().slice(0, 6);
const f = fixtures(tag);
const made = { group: null as string | null };
const TZ = "Africa/Cairo";
const today = eventDay(TZ);
const at = (hhmm: string) => zonedToIso(`${today}T${hhmm}`, TZ)!;
const ip = (n: number): Who => ({ "X-Forwarded-For": `203.0.113.${n}` });
const SESSION = "/api/mobile/v1/coach/session";
const ACTIONS = "src/app/admin/org/coaches/actions.ts";
const coachCookie = (token: string): Who => ({ Cookie: `mb_coach=${token}` });

async function finishDirect(m: Match, winner: TeamKey) {
  const t = (await getTournament(m.tournament_id))!;
  const cfg = scoringConfigForMatch(t, m, null, { doubles: m.rubber_type === "D" });
  let s = initialScoreState("A");
  let n = 0;
  while (!s.matchOver) {
    s = awardPoint(s, winner, cfg);
    n++;
  }
  await upsertSnapshotFromState(m, s, n);
  await finalizeMatch(m, { status: "completed", winnerTeamId: winner === "A" ? m.team_a_id! : m.team_b_id!, actorRole: "e2e" });
}

async function main() {
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;
  const ADMIN = staff("admin");

  /* ---------------- two tie events of one group ---------------- */
  const { data: g, error: ge } = await db().from("event_groups").insert({ slug: `e2e-coaches-${tag}`, name: `E2E Junior Finals ${tag}`, organization_id: MB, timezone: TZ }).select("id").single();
  if (ge) throw new Error(`event_groups: ${ge.message}`);
  made.group = (g as { id: string }).id;
  const BOYS = await f.tournament({ name: "Davis Juniors", sport: "tennis" });
  const GIRLS = await f.tournament({ name: "BJK Juniors", sport: "tennis" });
  await db()
    .from("tournaments")
    .update({ event_group_id: made.group, timezone: TZ, starts_on: today, ends_on: today, scoring_config: DEFAULT_TENNIS_SCORING_CONFIG, format_config: { ties: { rubbers: ["S2", "S1", "D"] }, qualifyPerGroup: 2 } })
    .in("id", [BOYS, GIRLS]);
  const [bc1, bc2] = await f.courts(BOYS, 2);
  await f.courts(GIRLS, 1);
  const setUp = async (tid: string, names: string[], codes: string[], ev: string) => {
    const r = await f.teams(tid, names, 4);
    for (const [i, t] of r.teams.entries()) {
      await db().from("teams").update({ nation_code: codes[i], team_name: `${names[i]} ${tag}` }).eq("id", t.id);
      for (const [j, pid] of t.players.entries()) await db().from("players").update({ full_name: `${codes[i]}${ev} Player${j + 1}` }).eq("id", pid);
    }
    return r.teams;
  };
  const bt = await setUp(BOYS, ["Egypt", "Spain", "Italy", "Japan"], ["EGY", "ESP", "ITA", "JPN"], "b");
  const gt = await setUp(GIRLS, ["Egypt", "France", "India", "Peru"], ["EGY", "FRA", "IND", "PER"], "g");
  const EGYB = bt[0];
  const EGYG = gt[0];
  await generateGroupTies(BOYS, "e2e");
  await generateGroupTies(GIRLS, "e2e");
  const ties = await getTies(BOYS);
  const egyTies = ties.filter((t) => t.team_a_id === EGYB.id || t.team_b_id === EGYB.id);
  const otherTie = ties.find((t) => t.team_a_id !== EGYB.id && t.team_b_id !== EGYB.id)!;
  check(ties.length === 6 && egyTies.length === 3, "six boys' ties, three of them Egypt's", [ties.length, egyTies.length]);
  const T1 = egyTies[0];
  await scheduleTie(BOYS, otherTie.id, bc2, at("09:30"), "e2e");
  const rubbersOf = async (tie: Pick<Tie, "id">) => ((await db().from("matches").select("*").eq("tie_id", tie.id).order("rubber_no")).data ?? []) as Match[];

  /* ---------------- the admin: one click, a list, the cards ---------------- */
  section("Admin: a code for every team (both events), the list, the cards");
  const mgr = await callAction(ACTIONS, "createCoachCodesAction", [form({ tournament_id: BOYS })], staff("manager"));
  const { count: none } = await db().from("coach_codes").select("id", { count: "exact", head: true }).in("tournament_id", [BOYS, GIRLS]);
  check(!actionOk(mgr) && none === 0, "a manager cannot make coach codes (admins only)", mgr.status);
  const mk = await callAction(ACTIONS, "createCoachCodesAction", [form({ tournament_id: BOYS })], ADMIN);
  check(actionOk(mk), "createCoachCodesAction answers", `${mk.status} ${mk.text.slice(0, 200)}`);
  const { data: codeRows } = await db().from("coach_codes").select("id, team_id, tournament_id, label, code_sealed, code_hash, expires_at").in("tournament_id", [BOYS, GIRLS]);
  const codes = (codeRows ?? []) as { id: string; team_id: string; tournament_id: string; label: string; code_sealed: string; code_hash: string; expires_at: string }[];
  check(codes.length === 8 && new Set(codes.map((c) => c.team_id)).size === 8, "one code per team, eight teams over both events", codes.length);
  check(codes.every((c) => Date.parse(c.expires_at) === Date.parse(at("23:59"))), "every code works until its event ends (23:59 Cairo)", codes.map((c) => c.expires_at));
  const again = await callAction(ACTIONS, "createCoachCodesAction", [form({ tournament_id: GIRLS })], ADMIN);
  const { count: still } = await db().from("coach_codes").select("id", { count: "exact", head: true }).in("tournament_id", [BOYS, GIRLS]);
  check(actionOk(again) && still === 8, "clicking again (from the girls' event) makes no second code", still);
  const codeOf = (teamId: string) => {
    const c = codes.find((x) => x.team_id === teamId)!;
    const plain = openEventCode(c.code_sealed)!;
    return { id: c.id, code: formatEventCode(plain), label: c.label, hashOk: hashEventCode(plain) === c.code_hash };
  };
  const CB = codeOf(EGYB.id);
  const CG = codeOf(EGYG.id);
  check(CB.hashOk && CB.code !== CG.code && /^Egypt .* · Davis Juniors/.test(CB.label) && /· BJK Juniors/.test(CG.label), "Egypt boys and Egypt girls have separate codes, labelled with their event", [CB.label, CG.label]);
  const page = await http("GET", `/admin/org/coaches?event=${BOYS}`, ADMIN);
  check(page.status === 200 && (page.text.match(/data-testid="coach-code-row"/g) ?? []).length === 8 && !page.text.includes(CB.code), "the Team coaches page lists the eight teams (never a code in the list)", page.status);
  const mgrPage = await http("GET", `/admin/org/coaches?event=${BOYS}`, staff("manager"));
  check(mgrPage.status !== 200 || !mgrPage.text.includes("coach-code-row"), "a manager does not get the Team coaches page", mgrPage.status);
  const cards = await http("GET", `/qr/coaches?event=${GIRLS}`, ADMIN);
  check(cards.status === 200 && (cards.text.match(/data-testid="coach-card"/g) ?? []).length === 8 && cards.text.includes(CB.code) && cards.text.includes("<svg"), "the printable cards: one per team, the QR and the code in text", cards.status);
  const one = await http("GET", `/qr/coaches?event=${BOYS}&team=${EGYG.id}`, ADMIN);
  check((one.text.match(/data-testid="coach-card"/g) ?? []).length === 1 && one.text.includes(CG.code), "one team's card on its own", one.status);
  const refCards = await http("GET", `/qr/coaches?event=${BOYS}`, staff("referee"));
  check(!refCards.text.includes(CB.code), "a referee cannot open the cards", refCards.status);
  check(parseCoachLink(coachLink(BASE_URL, CB.code)) === CB.code && new URL(coachLink(BASE_URL, CB.code)).pathname === "/c", "the card's QR is <site>/c#<code>");

  /* ---------------- signing in: two phones and the web, one code ---------------- */
  section("Egypt boys' coaches sign in: two phones and the web, the same code");
  const ph1 = await f.device("coach1");
  const ph2 = await f.device("coach2");
  const s1 = await http("POST", SESSION, { ...ip(11), "X-Install-Token": mintInstallToken(ph1.installationId) }, { code: CB.code.toLowerCase() });
  const s2 = await http("POST", SESSION, { ...ip(12), "X-Install-Token": mintInstallToken(ph2.installationId) }, { code: CB.code.replace(/-/g, "") });
  check(s1.status === 200 && s2.status === 200 && String(s1.json?.token).startsWith("mbc1.") && (s1.json?.team as { id: string }).id === EGYB.id, "both phones signed in as Egypt boys' coach", [s1.status, s2.status, s1.json?.team]);
  const C1: Who = bearer(String(s1.json?.token));
  const C2: Who = bearer(String(s2.json?.token));
  const { data: sess } = await db().from("coach_sessions").select("installation_id, ended_at").eq("code_id", CB.id);
  check((sess ?? []).length === 2 && [ph1.installationId, ph2.installationId].every((i) => (sess ?? []).some((s) => (s as { installation_id: string }).installation_id === i)), "two sign-ins, each with its phone", sess);
  const wrong = await http("POST", SESSION, ip(13), { code: "AAAA-BBBB-CCCC" });
  check(wrong.status === 401 && wrong.json?.code === "wrong_code", "a wrong code: 401 wrong_code", wrong.json);
  const asStaff = await http("POST", "/api/mobile/v1/staff/session", ip(14), { code: CB.code });
  check(asStaff.status === 401, "a coach code never signs in as staff", asStaff.status);
  const webIn = await callAction("src/app/coach/actions.ts", "coachSignInAction", [form({ code: CB.code })], ip(15));
  check(webIn.status === 303 || /\/coach\/team/.test(webIn.text), "web sign-in with the code goes to My team", webIn.status);
  const webBad = await callAction("src/app/coach/actions.ts", "coachSignInAction", [form({ code: "AAAA-BBBB-CCCC" })], ip(16));
  check(/wrong_code/.test(webBad.text) || webBad.status === 303, "web sign-in with a wrong code goes back with wrong_code", webBad.status);

  /* ---------------- line-ups (entered by the referee / organiser) ---------------- */
  section("Line-ups entered for Egypt's tie and another tie");
  const egySide: "A" | "B" = T1.team_a_id === EGYB.id ? "A" : "B";
  const oppId = egySide === "A" ? T1.team_b_id! : T1.team_a_id!;
  const opp = bt.find((t) => t.id === oppId)!;
  await setLineup(BOYS, T1.id, egySide, { S1: EGYB.players[0], S2: EGYB.players[1], D: [EGYB.players[2], EGYB.players[3]] }, "e2e");
  await setLineup(BOYS, T1.id, egySide === "A" ? "B" : "A", { S1: opp.players[0], S2: opp.players[1], D: [null, null] }, "e2e");
  const oA = bt.find((t) => t.id === otherTie.team_a_id)!;
  const oB = bt.find((t) => t.id === otherTie.team_b_id)!;
  await setLineup(BOYS, otherTie.id, "A", { S1: oA.players[0], S2: oA.players[1], D: [null, null] }, "e2e");
  await setLineup(BOYS, otherTie.id, "B", { S1: oB.players[0], S2: oB.players[1], D: [null, null] }, "e2e");
  await scheduleTie(BOYS, T1.id, bc1, new Date(Date.now() + 2 * 3600_000).toISOString(), "e2e");
  const lineupEv = await eventually(async () => {
    const { data } = await db().from("notification_events").select("kind, payload, fire_at, status").eq("tie_id", T1.id).like("kind", "coach_%");
    return (data ?? []) as { kind: string; payload: { title: string; body: string; targets: { kind: string; key: string }[] }; fire_at: string; status: string }[];
  }).then((r) => r);
  const lu = lineupEv.filter((e) => e.kind === "coach_lineup");
  const egyLu = lu.find((e) => e.payload.targets[0]?.key === EGYB.id);
  check(Boolean(egyLu) && /EGYb Player1/.test(egyLu!.payload.body) && !/ESPb|ITAb|JPNb/.test(JSON.stringify(egyLu!.payload)), "line-up alert to Egypt's coaches: their own players only", egyLu?.payload);
  const oppLu = lu.find((e) => e.payload.targets[0]?.key === oppId);
  check(lu.length === 2 && Boolean(oppLu) && !/EGYb/.test(JSON.stringify(oppLu!.payload)), "the opponent's coaches get their own line-up alert, which never names Egypt's players", lu.map((e) => [e.payload.targets[0]?.key, e.payload.body]));
  const soon = lineupEv.find((e) => e.kind === "coach_soon" && e.payload.targets[0]?.key === EGYB.id);
  check(Boolean(soon) && Math.abs(Date.parse(soon!.fire_at) - (Date.now() + 2 * 3600_000 - 5 * 60_000)) < 120_000 && soon!.status === "pending", "tie soon: queued for 5 minutes before the tie", soon);

  /* ---------------- My team ---------------- */
  section("My team: Egypt boys only");
  const team = await http("GET", "/api/mobile/v1/coach/team", C1);
  const v = team.json as unknown as import("../../src/lib/mobile/contract").MCoachTeamView;
  check(team.status === 200 && /no-store/.test(team.cache ?? ""), "GET coach/team: private, no-store", [team.status, team.cache]);
  check(v.team.id === EGYB.id && v.ties.length === 3 && v.ties.every((t) => egyTies.some((e) => e.id === t.id)), "three ties, all Egypt boys'", v.ties.map((t) => t.id));
  check(v.group?.rows.length === 4 && v.group.rows.some((r) => r.teamId === EGYB.id), "the group table (four teams)", v.group?.rows.length);
  const t1 = v.ties.find((t) => t.id === T1.id)!;
  check(t1.court === "Court 1" && Boolean(t1.scheduledTime) && t1.lineupEntered && t1.rubbers.every((r) => r.ours.length > 0), "Egypt's tie: court, time, its own line-up", { court: t1.court, entered: t1.lineupEntered });
  check(t1.rubbers.every((r) => r.theirs === null), "the opponents' line-up is not shown before the rubber starts", t1.rubbers.map((r) => r.theirs));
  check(!team.text.includes("ITAb Player") && !team.text.includes(`${opp.name.slice(0, 3).toUpperCase()}b Player`), "no other team's players anywhere in the payload", null);
  check(!/access_code|"phone"|"email"|referee/i.test(team.text), "no codes, phones, emails or referees in the payload");
  const slots = (i: number) => v.schedule.filter((s) => s.playerId === EGYB.players[i] && s.tieId === T1.id).map((s) => s.label);
  check(slots(0).join() === "No. 1 singles" && slots(1).join() === "No. 2 singles" && slots(2).join() === "Doubles" && slots(3).join() === "Doubles" && v.schedule.every((s) => s.court === "Court 1" || s.tieId !== T1.id), "players' schedule: who plays which rubber, on which court", [0, 1, 2, 3].map(slots));
  const team2 = await http("GET", "/api/mobile/v1/coach/team", C2);
  check(team2.status === 200, "the second phone reads it too", team2.status);
  const lu1 = await http("GET", `/api/mobile/v1/coach/ties/${T1.id}/lineup`, C1);
  check(lu1.status === 200 && (lu1.json?.rubbers as { players: { id: string }[] }[]).every((r) => r.players.every((p) => EGYB.players.includes(p.id))), "coach/ties/:id/lineup: Egypt's own line-up only", lu1.json);

  section("Another team's tie, rubber, line-up and log: the same 404 as a missing one");
  const otherRubber = (await rubbersOf(otherTie))[0];
  const girlsTie = (await getTies(GIRLS)).find((t) => t.team_a_id === EGYG.id || t.team_b_id === EGYG.id)!;
  const missing = randomUUID();
  for (const [what, path, bad] of [
    ["tie", `/api/mobile/v1/coach/ties/${otherTie.id}`, `/api/mobile/v1/coach/ties/${missing}`],
    ["line-up", `/api/mobile/v1/coach/ties/${otherTie.id}/lineup`, `/api/mobile/v1/coach/ties/${missing}/lineup`],
    ["rubber", `/api/mobile/v1/coach/matches/${otherRubber.id}`, `/api/mobile/v1/coach/matches/${missing}`],
    ["log", `/api/mobile/v1/coach/matches/${otherRubber.id}/log`, `/api/mobile/v1/coach/matches/${missing}/log`],
    ["Egypt girls' tie", `/api/mobile/v1/coach/ties/${girlsTie.id}`, `/api/mobile/v1/coach/ties/not-a-uuid`],
  ] as const) {
    const a = await http("GET", path, C1);
    const b = await http("GET", bad, C1);
    check(a.status === 404 && b.status === 404 && a.text === b.text, `${what}: 404, same as missing`, [a.status, b.status]);
  }

  section("Staff routes refuse a coach token; coach routes are read only");
  const r0 = (await rubbersOf(T1))[0];
  for (const [method, path, body] of [
    ["GET", "/api/mobile/v1/referee/tournaments", undefined],
    ["GET", `/api/mobile/v1/referee/tournaments/${BOYS}/matches`, undefined],
    ["GET", `/api/mobile/v1/referee/matches/${r0.id}/bootstrap`, undefined],
    ["GET", `/api/mobile/v1/referee/matches/${r0.id}/lineup`, undefined],
    ["POST", `/api/mobile/v1/referee/matches/${r0.id}/lineup`, { lineups: { [egySide]: { S1: EGYB.players[3], S2: EGYB.players[2], D: [] } } }],
    ["POST", `/api/mobile/v1/referee/tournaments/${BOYS}/lineups/apply`, { rows: [] }],
    ["POST", `/api/matches/${r0.id}/events`, { deviceId: "coach", events: [] }],
    ["POST", `/api/matches/${r0.id}/claim`, { deviceId: "coach", deviceLabel: "x" }],
    ["POST", `/api/matches/${r0.id}/call`, { action: "call", deviceId: "coach" }],
    ["GET", `/api/matches/${r0.id}/log`, undefined],
    ["POST", "/api/mobile/v1/referee/assistance", { action: "request", matchId: r0.id }],
    ["GET", "/api/mobile/v1/referee/assistance", undefined],
    ["GET", "/api/mobile/v1/referee/notices", undefined],
  ] as const) {
    const r = await http(method, path, C1, body);
    check(r.status === 401 || r.status === 403, `${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}: refused (${r.status})`, r.text.slice(0, 120));
  }
  const adminAsCoach = await http("GET", "/admin/org/coaches", coachCookie(String(s1.json?.token)));
  check(adminAsCoach.status !== 200, "admin pages refuse a coach cookie", adminAsCoach.status);
  const post = await http("POST", `/api/mobile/v1/coach/ties/${T1.id}/lineup`, C1, { S1: EGYB.players[3] });
  check(post.status === 405, "POST coach/ties/:id/lineup: 405 (read only)", post.status);
  const after = await rubbersOf(T1);
  check(JSON.stringify(after.map((m) => (egySide === "A" ? m.team_a_player_ids : m.team_b_player_ids))) === JSON.stringify((await rubbersOf(T1)).map((m) => (egySide === "A" ? m.team_a_player_ids : m.team_b_player_ids))) && after[0][egySide === "A" ? "team_a_player_ids" : "team_b_player_ids"]?.[0] === (r0.rubber_type === "S1" ? EGYB.players[0] : r0.rubber_type === "S2" ? EGYB.players[1] : EGYB.players[2]), "the line-up is unchanged", after.map((m) => m.team_a_player_ids));

  /* ---------------- live: started, called, log, finished ---------------- */
  section("Live: the rubber starts, its log, called to court, finished");
  const dev = `desk-${tag}`;
  const S2R = after.find((m) => m.rubber_type === "S2")!;
  const call = await http("POST", `/api/matches/${S2R.id}/call`, ADMIN, { action: "call", deviceId: dev });
  check([200, 201].includes(call.status), "the desk calls Egypt's S2 to court", `${call.status} ${call.text.slice(0, 160)}`);
  const claim = await http("POST", `/api/matches/${S2R.id}/claim`, ADMIN, { deviceId: dev, deviceLabel: "Desk" });
  check(claim.status === 200, "the desk claims it to score", claim.status);
  const cfg = scoringConfigForMatch((await getTournament(BOYS))!, S2R, null, { doubles: false });
  const s0 = initialScoreState("A");
  const p1 = awardPoint(s0, "A", cfg);
  const p2 = awardPoint(p1, "B", cfg);
  const evs = await sendEvents(S2R.id, ADMIN, [scoreEvent(1, "MATCH_STARTED", null, s0, { payload: { first_server: "A" } }), scoreEvent(2, "POINT_AWARDED", s0, p1, { team_id: S2R.team_a_id }), scoreEvent(3, "POINT_AWARDED", p1, p2, { team_id: S2R.team_b_id })], dev);
  check(evs.status === 200, "start and two points are scored", evs.text.slice(0, 160));
  const live = await http("GET", `/api/mobile/v1/coach/matches/${S2R.id}`, C1);
  const lm = live.json as unknown as import("../../src/lib/mobile/contract").MCoachMatch;
  check(live.status === 200 && lm.rubber.status === "live" && Array.isArray(lm.rubber.theirs) && lm.rubber.theirs!.length === 1 && lm.rubber.ours[0].id === EGYB.players[1], "the live rubber: our player and, now it is under way, the opponent's", lm?.rubber);
  check(Boolean(lm.rubber.score?.points), "live score with the point score", lm?.rubber.score);
  check(lm.log.length >= 3 && !/"by"|Admin|admin|referee/i.test(JSON.stringify(lm.log)), "the match log, without who entered it", lm.log.map((e) => e.title));
  const log = await http("GET", `/api/mobile/v1/coach/matches/${S2R.id}/log`, C2);
  check(log.status === 200 && (log.json?.log as unknown[]).length === lm.log.length, "coach/matches/:id/log on the second phone", log.status);
  await finishDirect((await rubbersOf(T1)).find((m) => m.id === S2R.id)!, egySide);
  const kinds = await eventually(async () => {
    const { data } = await db().from("notification_events").select("kind, payload").eq("match_id", S2R.id).like("kind", "coach_%");
    const rows = (data ?? []) as { kind: string; payload: { targets: { key: string }[]; title: string } }[];
    const mine = rows.filter((r) => r.payload.targets[0]?.key === EGYB.id).map((r) => r.kind);
    return ["coach_called", "coach_started", "coach_finished"].every((k) => mine.includes(k)) ? rows : null;
  }, 8000);
  check(Boolean(kinds), "coach alerts for Egypt: called to court, started, finished", kinds?.map((k) => [k.kind, k.payload.title]));
  const won = kinds?.find((k) => k.kind === "coach_finished" && k.payload.targets[0]?.key === EGYB.id);
  check(Boolean(won) && /^Won: No\. 2 singles/.test(won!.payload.title), "the result reads from Egypt's side", won?.payload.title);

  section("Alerts reach both coach phones (dry run)");
  const { drainNotifications } = await import("../../src/lib/notify/drain");
  await db().from("notification_events").update({ fire_at: new Date().toISOString() }).eq("tie_id", T1.id).eq("kind", "coach_soon").eq("status", "pending");
  process.env.PUSH_DRY_RUN = "1";
  for (let i = 0; i < 4; i++) await drainNotifications(50);
  const { data: evRows } = await db().from("notification_events").select("id, kind, payload").eq("tournament_id", BOYS).like("kind", "coach_%");
  const egyEvents = ((evRows ?? []) as { id: string; kind: string; payload: { targets: { key: string }[] } }[]).filter((e) => e.payload.targets[0]?.key === EGYB.id);
  const { data: dl } = await db().from("notification_deliveries").select("event_id, device_id, status, ticket_id").in("event_id", egyEvents.map((e) => e.id));
  const deliveries = (dl ?? []) as { event_id: string; device_id: string; status: string; ticket_id: string }[];
  const sentTo = (k: string) => new Set(deliveries.filter((d) => egyEvents.find((e) => e.id === d.event_id)?.kind === k && d.status === "sent").map((d) => d.device_id));
  for (const k of ["coach_lineup", "coach_soon", "coach_called", "coach_started", "coach_finished"]) {
    const to = sentTo(k);
    check(to.has(ph1.id) && to.has(ph2.id), `${k}: sent to both coach phones (dry run)`, [...to]);
  }
  check(deliveries.every((d) => [ph1.id, ph2.id].includes(d.device_id) && (d.ticket_id ?? "").startsWith("dry-run")), "Egypt's coach alerts went to its coach phones only, nothing sent for real", deliveries.length);

  /* ---------------- the web view ---------------- */
  section("The web: /coach/team, a tie, a match, another team's tie");
  const W = coachCookie(String(s1.json?.token));
  const web = await http("GET", "/coach/team", W);
  check(web.status === 200 && web.text.includes('data-testid="coach-team"') && (web.text.match(/data-testid="coach-tie"/g) ?? []).length >= 3 && web.text.includes("coach-group"), "My team on the web: ties and the group table", web.status);
  const webTie = await http("GET", `/coach/ties/${T1.id}`, W);
  const webMatch = await http("GET", `/coach/matches/${S2R.id}`, W);
  const webOther = await http("GET", `/coach/ties/${otherTie.id}`, W);
  const webOtherM = await http("GET", `/coach/matches/${otherRubber.id}`, W);
  check(webTie.status === 200 && webMatch.status === 200 && webMatch.text.includes("coach-log"), "the tie and the match (with its log) open", [webTie.status, webMatch.status]);
  check(webOther.status === 404 && webOtherM.status === 404, "another team's tie and match: 404", [webOther.status, webOtherM.status]);
  const signedOut = await http("GET", "/coach/team");
  check(signedOut.status === 307 || signedOut.status === 303 || signedOut.status === 302, "no coach cookie: back to the sign-in", signedOut.status);

  /* ---------------- the QR page without the app ---------------- */
  section("The card's QR page without the app; AASA");
  const qr = await http("GET", "/c");
  check(qr.status === 200 && qr.text.includes('data-testid="coach-qr"') && qr.text.includes('data-testid="get-android"') && qr.text.includes('data-testid="get-ios"'), "/c: the download links", qr.status);
  check(!/set-cookie/i.test(qr.text) && !qr.text.includes(CB.code), "/c never signs in by itself and carries no code (it is in the #fragment)");
  const aasa = await http("GET", "/.well-known/apple-app-site-association");
  const paths = ((aasa.json?.applinks as { details: { paths: string[] }[] }).details[0]!.paths) ?? [];
  check(["/v/*", "/m/*", "/r", "/c"].every((p) => paths.includes(p)) && !paths.includes("/c/*") && !paths.includes("/*"), "AASA: /c beside 1.0.1's paths (exactly /c, so /coach stays in the browser)", paths);

  // Screenshots (optional): COACH_PAUSE_FILE=<path> writes what a browser needs to <path>.json
  // and waits (up to 10 minutes) until <path> is deleted.
  const pause = process.env.COACH_PAUSE_FILE;
  if (pause) {
    const { writeFileSync, existsSync } = await import("node:fs");
    const { sessionToken } = await import("./lib/session");
    writeFileSync(pause, "waiting");
    writeFileSync(`${pause}.json`, JSON.stringify({ admin: sessionToken("admin"), coach: String(s1.json?.token), event: BOYS, team: EGYB.id, tie: T1.id, match: S2R.id }));
    for (let i = 0; i < 600 && existsSync(pause); i++) await new Promise((r) => setTimeout(r, 1000));
  }

  /* ---------------- revoke, new code ---------------- */
  section("Revoking a code signs every device out; a new code replaces the old");
  const rv = await callAction(ACTIONS, "revokeCoachCodeAction", [form({ code_id: CB.id })], ADMIN);
  check(actionOk(rv), "revokeCoachCodeAction", rv.status);
  const a1 = await http("GET", "/api/mobile/v1/coach/team", C1);
  const a2 = await http("GET", "/api/mobile/v1/coach/team", C2);
  const aw = await http("GET", "/coach/team", W);
  check(a1.status === 401 && a1.json?.code === "code_revoked" && a2.status === 401 && aw.status !== 200, "both phones and the web are refused on their next request", [a1.status, a1.json?.code, a2.status, aw.status]);
  const again1 = await http("POST", SESSION, ip(17), { code: CB.code });
  check(again1.status === 401 && again1.json?.code === "code_revoked", "the revoked code no longer signs in", again1.json);
  const { data: ended } = await db().from("coach_sessions").select("ended_at").eq("code_id", CB.id);
  check((ended ?? []).every((s) => (s as { ended_at: string | null }).ended_at), "its sign-ins are ended (no more alerts)", ended);
  const gs = await http("POST", SESSION, ip(18), { code: CG.code });
  check(gs.status === 200 && (gs.json?.team as { id: string }).id === EGYG.id, "Egypt girls' code still works (a separate code)", gs.status);
  const regen = await callAction(ACTIONS, "regenerateCoachCodeAction", [form({ code_id: CG.id })], ADMIN);
  check(actionOk(regen), "regenerateCoachCodeAction", regen.status);
  const oldG = await http("GET", "/api/mobile/v1/coach/team", bearer(String(gs.json?.token)));
  const { data: newRow } = await db().from("coach_codes").select("id, code_sealed").eq("team_id", EGYG.id).is("revoked_at", null).single();
  const newCode = formatEventCode(openEventCode((newRow as { code_sealed: string }).code_sealed)!);
  const ns = await http("POST", SESSION, ip(19), { code: newCode });
  check(oldG.status === 401 && ns.status === 200 && newCode !== CG.code, "the old girls' code stops at once; the new one signs in", [oldG.status, ns.status]);

  /* ---------------- brakes ---------------- */
  section("Brakes on guessing: failed attempts only");
  await db().from("request_counters").delete().like("bucket_key", "coach-%");
  for (let i = 0; i < 3; i++) await http("POST", SESSION, ip(40), { code: newCode });
  let last = 0;
  for (let i = 0; i < 20; i++) last = (await http("POST", SESSION, ip(40), { code: `ZZZZ-ZZZZ-ZZ${String(i).padStart(2, "2").replace(/[01]/g, "2")}` })).status;
  const locked = await http("POST", SESSION, ip(40), { code: newCode });
  const elsewhere = await http("POST", SESSION, ip(41), { code: newCode });
  check(last === 401 && locked.status === 429 && elsewhere.status === 200, "20 wrong codes from one address close it (right codes before did not count); another address still signs in", [last, locked.status, elsewhere.status]);
  await db().from("request_counters").delete().like("bucket_key", "coach-%");
}

main()
  .catch((e) => {
    console.error(e);
    check(false, "script error", String(e));
  })
  .finally(async () => {
    const ok = await f.cleanup();
    if (made.group) await db().from("event_groups").delete().eq("id", made.group);
    await db().from("request_counters").delete().like("bucket_key", "coach-%");
    check(ok, "cleanup: everything made here is gone");
    finish("coaches");
  });
