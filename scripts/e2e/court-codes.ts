/**
 * Court referee codes (migration 0034), end to end on the stand-in: two events of
 * one event group (the Junior Finals' shape), a code per physical court made with
 * the organiser's one-click action, and a Court 1 referee who
 *   - sees only Court 1's matches, across both events, and today's only (live,
 *     upcoming in order, finished today; tomorrow's and yesterday's are not listed),
 *   - can score them (events, claim, lease, call, bootstrap, the web score page),
 *   - is refused with the same 404 as a missing match on Court 2's match on every
 *     route, and on another organisation's,
 *   - sees a match (and a tie's rubbers) moved to Court 1 at once, and loses one
 *     moved away (its scoring refused),
 *   - fails on the next request once the code is revoked;
 * the court QR (/r: universal link for the app; without the app a page with the
 * download links, never a browser sign-in), "Show earlier days" with scores (web and
 * app), switching courts (never blocked: the old court's unsent / unfinished matches
 * stay reachable through a carry-over token, only those, lapsing by itself), a new
 * code for one court, the QR sheet, and a typed court code in the app shapes 1.0.1 reads.
 *
 *   npm run localdb                                     # another terminal
 *   npm run build && npx next start -p 3077             # env from .env.localdb
 *   npm run e2e:court-codes
 *
 * Creates and deletes its own data.
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState } from "../../src/lib/scoring/engine";
import { DEFAULT_SCORING_CONFIG, type Match } from "../../src/lib/types";
import { formatEventCode, hashEventCode, openEventCode } from "../../src/lib/orgs/codes";
import QRCode from "qrcode";
import { courtLink, parseCourtLink } from "../../src/lib/orgs/courtScope";
import { siteUrl } from "../../src/lib/messaging/links";
import { eventDay } from "../../src/lib/matchday/eventDay";
import { zonedToIso } from "../../src/lib/tennis/ties";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { BASE_URL, assertStandIn, bearer, check, cookie, finish, fixtures, http, lastEvent, scoreEvent, section, sendEvents, staff, type Who } from "./lib/fixtures";
import { actionOk, callAction, form } from "./lib/actions";
import { hashRefereePin } from "../../src/lib/referees/pin";

assertStandIn("court-codes");

const tag = randomUUID().slice(0, 6);
const f = fixtures(tag);
const made = { group: null as string | null, codes: [] as string[], referee: null as string | null };
// Referee PINs (migration 0035): a court code signs in only with a referee's PIN.
const PIN = "4826";

const TZ = "Africa/Cairo";
const today = eventDay(TZ);
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => zonedToIso(`${day}T${hhmm}`, TZ)!;

async function main() {
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;
  const ADMIN = staff("admin");

  /* ---------------- two events of one group ---------------- */
  const { data: g, error: ge } = await db()
    .from("event_groups")
    .insert({ slug: `e2e-courts-${tag}`, name: `E2E Junior Finals ${tag}`, organization_id: MB, timezone: TZ })
    .select("id")
    .single();
  if (ge) throw new Error(`event_groups: ${ge.message}`);
  made.group = (g as { id: string }).id;
  const BOYS = await f.tournament({ name: "Courts Boys" });
  const GIRLS = await f.tournament({ name: "Courts Girls" });
  await db().from("tournaments").update({ event_group_id: made.group, timezone: TZ, starts_on: shift(today, -1) }).in("id", [BOYS, GIRLS]);
  await db().from("tournaments").update({ ends_on: shift(today, 2) }).eq("id", BOYS);
  await db().from("tournaments").update({ ends_on: shift(today, 3) }).eq("id", GIRLS);
  // Boys: Court 1, Court 2. Girls: Court 1 (the same physical court), Court 3.
  const ins = async (tid: string, names: string[]) => {
    const { data } = await db().from("courts").insert(names.map((n, i) => ({ tournament_id: tid, court_name: n, court_order: i + 1 }))).select("id, court_name");
    return Object.fromEntries(((data ?? []) as { id: string; court_name: string }[]).map((c) => [c.court_name, c.id])) as Record<string, string>;
  };
  const bc = await ins(BOYS, ["Court 1", "Court 2"]);
  const gc = await ins(GIRLS, ["court 1", "Court 3"]);
  const bt = (await f.teams(BOYS, ["Egypt", "Spain", "Italy", "Japan"])).teams;
  const gt = (await f.teams(GIRLS, ["France", "Chile", "India", "Peru"])).teams;

  const m = (tid: string, a: string | null, b: string | null, court: string | null, time: string | null, order: number, extra: Partial<Match> = {}) =>
    f.match(tid, { team_a_id: a, team_b_id: b, court_id: court, scheduled_time: time, match_order: order, ...extra });
  const B1 = await m(BOYS, bt[0].id, bt[1].id, bc["Court 1"], at(today, "15:00"), 1); // Court 1, today, later
  const B0 = await m(BOYS, bt[2].id, bt[3].id, bc["Court 1"], at(today, "09:00"), 2); // Court 1, today, earlier
  const B2 = await m(BOYS, bt[0].id, bt[2].id, bc["Court 2"], at(today, "10:00"), 3); // Court 2
  const BT = await m(BOYS, bt[1].id, bt[3].id, bc["Court 1"], at(shift(today, 1), "10:00"), 4); // Court 1, tomorrow
  const BY = await m(BOYS, bt[1].id, bt[2].id, bc["Court 1"], at(shift(today, -1), "10:00"), 5, { status: "completed", ended_at: at(shift(today, -1), "11:30") }); // yesterday
  const BF = await m(BOYS, bt[0].id, bt[3].id, bc["Court 1"], at(today, "08:00"), 6, { status: "completed", ended_at: new Date().toISOString() }); // finished today
  const G1 = await m(GIRLS, gt[0].id, gt[1].id, gc["court 1"], at(today, "11:00"), 1); // the girls' Court 1, today
  const G3 = await m(GIRLS, gt[2].id, gt[3].id, gc["Court 3"], at(today, "11:00"), 2); // Court 3
  // A tie on Court 3 with one rubber (tennis ties: each rubber is a match with a court).
  const { data: tie } = await db()
    .from("ties")
    .insert({ tournament_id: GIRLS, team_a_id: gt[0].id, team_b_id: gt[2].id, court_id: gc["Court 3"], scheduled_time: at(today, "16:00"), tie_order: 1 })
    .select("id")
    .single();
  const TIE = (tie as { id: string }).id;
  const R1 = await m(GIRLS, gt[0].id, gt[2].id, gc["Court 3"], at(today, "16:00"), 3, { tie_id: TIE, rubber_type: "S1", team_a_player_ids: [gt[0].players[0]], team_b_player_ids: [gt[2].players[0]] } as Partial<Match>);

  /* ---------------- the organiser: one click, a list, a QR sheet ---------------- */
  section("Admin: Create a code for every court (event group), list, QR sheet");
  const create = await callAction("src/app/admin/org/codes/courts/actions.ts", "createCourtCodesAction", [form({ tournament_id: BOYS, expires: "event_end" })], ADMIN);
  check(actionOk(create), "createCourtCodesAction answers", `${create.status} ${create.text.slice(0, 200)}`);
  const { data: codeRows } = await db()
    .from("organization_codes")
    .select("id, court_name, label, tournament_id, event_group_id, code_sealed, code_hash, expires_at")
    .eq("event_group_id", made.group);
  const codes = (codeRows ?? []) as { id: string; court_name: string; label: string; tournament_id: string | null; event_group_id: string; code_sealed: string; code_hash: string; expires_at: string | null }[];
  made.codes.push(...codes.map((c) => c.id));
  check(codes.length === 3 && ["Court 1", "Court 2", "Court 3"].every((n) => codes.some((c) => c.court_name.toLowerCase() === n.toLowerCase())), "one code per physical court across both events (Court 1, 2, 3)", codes.map((c) => c.court_name));
  const eventEnd = at(shift(today, 3), "23:59");
  check(codes.every((c) => c.tournament_id === null && c.label.endsWith(" referee") && c.expires_at !== null && Date.parse(c.expires_at) === Date.parse(eventEnd)), "group-scoped, labelled 'Court N referee', working until the events end (the girls' last day, 23:59 Cairo)", codes.map((c) => [c.label, c.expires_at]));
  const codeOf = (court: string) => {
    const c = codes.find((x) => x.court_name.toLowerCase() === court.toLowerCase())!;
    const plain = openEventCode(c.code_sealed)!;
    check(Boolean(plain) && hashEventCode(plain) === c.code_hash, `${court}: the sealed code opens to the code that signs in`);
    return { id: c.id, code: formatEventCode(plain) };
  };
  const C1 = codeOf("Court 1");
  const C2 = codeOf("Court 2");
  const again = await callAction("src/app/admin/org/codes/courts/actions.ts", "createCourtCodesAction", [form({ tournament_id: GIRLS })], ADMIN);
  const { count: still } = await db().from("organization_codes").select("id", { count: "exact", head: true }).eq("event_group_id", made.group);
  check(actionOk(again) && still === 3, "clicking again (from the other event of the group) makes no second code for a covered court", still);
  const page = await http("GET", `/admin/org/codes/courts?event=${BOYS}`, ADMIN);
  check(page.status === 200 && (page.text.match(/data-testid="court-code-row"/g) ?? []).length === 3 && page.text.includes("Court 1 referee"), "the court codes page lists the three courts with their codes", page.status);
  const sheet = await http("GET", `/qr/courts?event=${GIRLS}`, ADMIN);
  check(sheet.status === 200 && (sheet.text.match(/data-testid="court-sheet-page"/g) ?? []).length === 3 && sheet.text.includes(C1.code) && sheet.text.includes("<svg"), "the QR sheet: one page per court, a QR and the code in text", sheet.status);
  check(/no-store|private/.test(sheet.cache ?? "") || sheet.cache === null || /no-cache/.test(sheet.cache ?? ""), "the sheet is not cached publicly", sheet.cache);
  const sheetRef = await http("GET", `/qr/courts?event=${GIRLS}`, staff("referee"));
  check(sheetRef.status !== 200 || !sheetRef.text.includes(C1.code), "a referee cannot open the QR sheet", sheetRef.status);
  // The server's PUBLIC_SITE_URL (the gates start it with http://localhost:3077), else tour.mbeg.org.
  const pathOf = (svg: string) => /<path[^>]*stroke="#05060a"[^>]*d="([^"]+)"/.exec(svg)?.[1] ?? /d="([^"]+)"/g.exec(svg)?.[1] ?? "";
  let link = "";
  for (const site of [siteUrl(), BASE_URL]) {
    const candidate = courtLink(site, C1.code);
    const want = await QRCode.toString(candidate, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#05060a", light: "#ffffff" } });
    if (sheet.text.includes(pathOf(want).slice(0, 400))) link = candidate;
  }
  check(Boolean(link) && new URL(link).pathname === "/r" && parseCourtLink(link) === C1.code, "Court 1's QR encodes <public site>/r#<its code>", link.replace(/#.*/, "#…"));

  const { data: refRow, error: refErr } = await db()
    .from("referees")
    .insert({ organization_id: MB, name: `E2E Court Ref ${tag}`, role: "referee", pin_hash: hashRefereePin(MB, PIN) })
    .select("id")
    .single();
  if (refErr) throw new Error(`referees: ${refErr.message}`);
  made.referee = (refRow as { id: string }).id;

  /* ---------------- a Court 1 referee in the app (typed code) ---------------- */
  section("App: a Court 1 code typed by hand");
  const s1 = await http("POST", "/api/mobile/v1/staff/session", {}, { code: C1.code.toLowerCase(), pin: PIN });
  check(s1.status === 200 && typeof s1.json?.token === "string" && s1.json.role === "referee" && (s1.json.court as { name: string } | null)?.name === "Court 1" && s1.json.scope === null, "staff/session: token, role referee, court Court 1 (scope null: the group, not one tournament)", s1.json);
  const REF: Who = bearer(String(s1.json?.token));
  const list = await http("GET", "/api/mobile/v1/referee/tournaments", REF);
  const ids = ((list.json?.tournaments ?? []) as { id: string }[]).map((t) => t.id).sort();
  check(list.status === 200 && ids.length === 2 && ids.includes(BOYS) && ids.includes(GIRLS), "referee/tournaments: both events of the group (both have Court 1), nothing else", ids);
  const pick = await http("GET", `/api/mobile/v1/referee/tournaments/${BOYS}/matches`, REF);
  const pickIds = ((pick.json?.matches ?? []) as { id: string }[]).map((x) => x.id);
  check(pick.status === 200 && JSON.stringify(pickIds) === JSON.stringify([B0.id, B1.id, BF.id]), "boys' picker: Court 1 today only — upcoming in time order, then finished today (not Court 2, tomorrow or yesterday)", { got: pickIds, want: [B0.id, B1.id, BF.id] });
  const prow = (pick.json?.matches as Record<string, unknown>[] | undefined)?.[0];
  check(Boolean(prow) && ["id", "order", "round", "court", "scheduledTime", "status", "tieId", "rubberType", "a", "b", "lineupsMissing", "heldBy"].every((k) => k in prow!), "…with every field 1.0.1's picker reads", prow && Object.keys(prow));
  const gpick = await http("GET", `/api/mobile/v1/referee/tournaments/${GIRLS}/matches`, REF);
  check(JSON.stringify(((gpick.json?.matches ?? []) as { id: string }[]).map((x) => x.id)) === JSON.stringify([G1.id]), "girls' picker: their Court 1 match only", gpick.json?.matches);

  section("Scoring Court 1's matches (both events)");
  const dev = `court1-${tag}`;
  const boot = await http("GET", `/api/mobile/v1/referee/matches/${B0.id}/bootstrap`, REF);
  check(boot.status === 200 && (boot.json?.match as { id: string } | undefined)?.id === B0.id, "bootstrap a Court 1 match", boot.status);
  const claim = await http("POST", `/api/matches/${B0.id}/claim`, REF, { deviceId: dev, deviceLabel: "Court 1 phone" });
  check(claim.status === 200 && claim.json?.controller === true, "claim it", claim.json);
  const s0 = initialScoreState("A");
  const p1 = awardPoint(s0, "A", DEFAULT_SCORING_CONFIG);
  const ev = await sendEvents(B0.id, REF, [scoreEvent(1, "MATCH_STARTED", null, s0, { payload: { first_server: "A" } }), scoreEvent(2, "POINT_AWARDED", s0, p1, { team_id: B0.team_a_id })], dev);
  check(ev.status === 200 && (await lastEvent(B0.id)).n === 2, "events: start and a point are applied", ev.text.slice(0, 200));
  const renew = await http("POST", `/api/matches/${B0.id}/renew-lease`, REF, { deviceId: dev });
  check(renew.status === 200, "renew-lease", renew.status);
  const callG = await http("POST", `/api/matches/${G1.id}/call`, REF, { action: "call", deviceId: dev });
  check([200, 201, 409].includes(callG.status), "call the girls' Court 1 match to court (reaches it)", `${callG.status} ${callG.text.slice(0, 160)}`);
  const audit = await db().from("audit_logs").select("actor_user_id, action, actor_name").eq("actor_user_id", `code:${C1.id}`).limit(20);
  check(((audit.data ?? []) as { action: string }[]).length > 0, "scoring actions are audited with the code's id (code:<id>)", (audit.data ?? []).map((a) => (a as { action: string }).action));
  const webScore = await http("GET", `/referee/matches/${B0.id}/score`, cookie(String(s1.json?.token)));
  check(webScore.status === 200, "the web score page opens for the Court 1 match", webScore.status);

  section("Court 2's match: the same 404 as a missing match, on every route");
  const missing = randomUUID();
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/mobile/v1/referee/matches/:id/bootstrap"],
    ["POST", "/api/matches/:id/events", { deviceId: dev, events: [scoreEvent(1, "MATCH_STARTED", null, s0, { payload: { first_server: "A" } })] }],
    ["POST", "/api/matches/:id/claim", { deviceId: dev, deviceLabel: "x" }],
    ["POST", "/api/matches/:id/renew-lease", { deviceId: dev }],
    ["POST", "/api/matches/:id/release-lease", { deviceId: dev }],
    ["POST", "/api/matches/:id/request-control", { deviceId: dev, deviceLabel: "x" }],
    ["POST", "/api/matches/:id/respond-control", { deviceId: dev, accept: true }],
    ["POST", "/api/matches/:id/call", { action: "call", deviceId: dev }],
    ["GET", "/api/matches/:id/call"],
  ];
  for (const [method, path, body] of routes) {
    const theirs = await http(method, path.replace(":id", B2.id), REF, body);
    const none = await http(method, path.replace(":id", missing), REF, body);
    check(theirs.status === 404 && theirs.status === none.status && theirs.json?.error === none.json?.error, `${method} ${path}: Court 2 → 404, same as a missing match`, { court2: theirs.status, missing: none.status, err: theirs.json?.error });
  }
  const webOther = await http("GET", `/referee/matches/${B2.id}/score`, cookie(String(s1.json?.token)));
  check(webOther.status === 404, "the web score page of Court 2's match is a 404", webOther.status);
  const otherTournament = await f.tournament({ name: "Courts Elsewhere" });
  const oc = await ins(otherTournament, ["Court 1"]);
  const OX = await m(otherTournament, null, null, oc["Court 1"], at(today, "10:00"), 1);
  const ox = await http("POST", `/api/matches/${OX.id}/claim`, REF, { deviceId: dev, deviceLabel: "x" });
  check(ox.status === 404, "'Court 1' of an event outside the group is not this code's court", ox.status);
  const oxList = await http("GET", `/api/mobile/v1/referee/tournaments/${otherTournament}/matches`, REF);
  check(oxList.status === 404, "…nor is that event's match list", oxList.status);
  const rubberBefore = await http("POST", `/api/matches/${R1.id}/claim`, REF, { deviceId: dev, deviceLabel: "x" });
  check(rubberBefore.status === 404, "the tie rubber on Court 3: refused", rubberBefore.status);

  section("Moves: to Court 1 appears at once, away disappears and is refused");
  await db().from("matches").update({ court_id: bc["Court 1"] }).eq("id", B2.id);
  const moved = await http("GET", `/api/mobile/v1/referee/tournaments/${BOYS}/matches`, REF);
  check(((moved.json?.matches ?? []) as { id: string }[]).some((x) => x.id === B2.id), "a match moved to Court 1 appears", moved.status);
  const movedClaim = await http("POST", `/api/matches/${B2.id}/claim`, REF, { deviceId: `${dev}-b2`, deviceLabel: "x" });
  check(movedClaim.status === 200, "…and can be scored", movedClaim.status);
  await db().from("matches").update({ court_id: bc["Court 2"] }).eq("id", B1.id);
  const away = await http("GET", `/api/mobile/v1/referee/tournaments/${BOYS}/matches`, REF);
  check(!((away.json?.matches ?? []) as { id: string }[]).some((x) => x.id === B1.id), "a match moved away disappears", away.status);
  const awayEv = await sendEvents(B1.id, REF, [scoreEvent(1, "MATCH_STARTED", null, s0, { payload: { first_server: "A" } })], dev);
  check(awayEv.status === 404, "…and its scoring is refused (404)", awayEv.status);
  const sched = await callAction("src/app/admin/tournaments/[id]/ties/actions.ts", "scheduleTieAction", [null, form({ tournament_id: GIRLS, tie_id: TIE, court_id: gc["court 1"], scheduled_local: `${today}T16:00` })], ADMIN, { id: GIRLS });
  check(actionOk(sched), "the desk moves the tie to Court 1 (Ties page)", `${sched.status} ${sched.text.slice(0, 160)}`);
  const tieList = await http("GET", `/api/mobile/v1/referee/tournaments/${GIRLS}/matches`, REF);
  const rubberRow = ((tieList.json?.matches ?? []) as { id: string; tieId: string | null; rubberType: string | null }[]).find((x) => x.id === R1.id);
  check(rubberRow?.tieId === TIE && rubberRow.rubberType === "S1", "its rubber is now on Court 1's list (tieId, rubberType)", tieList.json?.matches);
  const rubberClaim = await http("POST", `/api/matches/${R1.id}/claim`, REF, { deviceId: `${dev}-r1`, deviceLabel: "x" });
  check(rubberClaim.status === 200, "…and the rubber can be scored", rubberClaim.status);

  section("The court QR: opens the app; without the app, a page with the download links (no browser sign-in)");
  const aasa = await http("GET", "/.well-known/apple-app-site-association");
  const paths = ((aasa.json?.applinks as { details: { paths: string[] }[] } | undefined)?.details?.[0]?.paths ?? []) as string[];
  check(["/v/*", "/m/*", "/r"].every((x) => paths.includes(x)) && !paths.includes("/r/*") && !paths.includes("/*"), "AASA: /r added beside 1.0.1's /v/* and /m/* (nothing else, so /register stays in the browser)", paths);
  const r = await http("GET", "/r");
  check(r.status === 200 && r.text.includes('data-testid="court-qr"') && r.text.includes("/movescore/android") && !r.text.includes(C1.code), "GET /r: the 'Open in Move Score' page with the Android download link, and no code in it (the code is only in the #fragment)", r.status);
  const rRaw = await fetch(`${BASE_URL}/r`);
  check(!rRaw.headers.get("set-cookie"), "…and it sets no cookie");
  const gone = await http("POST", "/api/referee/sign-in", { Origin: BASE_URL }, { code: C1.code });
  check(gone.status === 404 || gone.status === 405, "there is no browser sign-in from the QR", gone.status);
  // The app opens the link and signs in with the code (POST staff/session), as typed codes do.
  const web = await http("POST", "/api/mobile/v1/staff/session", {}, { code: C1.code, pin: PIN });
  const webToken = String(web.json?.token ?? "");
  const home = await http("GET", "/referee", cookie(webToken));
  const listed = [...home.text.matchAll(/data-match-id="([0-9a-f-]{36})"/g)].map((x) => x[1]);
  check(home.status === 200 && home.text.includes('data-testid="court-list"') && home.text.includes(">Court 1<"), "web console with a typed Court 1 code: the court's own list, headed Court 1", home.status);
  check([B0.id, B2.id, BF.id, G1.id, R1.id].every((id) => listed.includes(id)) && ![B1.id, BT.id, G3.id].some((id) => listed.includes(id)), "…both events' Court 1 matches today (incl. the moved match and rubber)", listed);
  const tpage = await http("GET", `/referee/tournaments/${BOYS}/matches`, cookie(webToken));
  check(tpage.status === 200 && !tpage.text.includes(`/referee/matches/${BT.id}/score`) && !tpage.text.includes(`/referee/matches/${B1.id}/score`), "the web tournament page is filtered to the court too", tpage.status);

  section("Show earlier days (hidden by default), with scores");
  await db().from("match_score_snapshots").insert({ match_id: BY.id, tournament_id: BOYS, last_event_number: 0, snapshot_json: { ...initialScoreState("A"), completedSets: [{ teamAGames: 6, teamBGames: 4 }, { teamAGames: 6, teamBGames: 3 }], matchOver: true, winner: "A" } });
  const ear = await http("GET", "/referee", cookie(webToken));
  const earText = ear.text.replace(/<!-- -->/g, "");
  check(/<details[^>]*data-testid="earlier-days"/.test(earText) && !/<details[^>]*open/.test(earText) && earText.includes(BY.id) && earText.includes("6-4 6-3"), "web: a closed 'Show earlier days' with yesterday's match and its score", earText.includes(BY.id));
  const appToday = await http("GET", `/api/mobile/v1/referee/tournaments/${BOYS}/matches`, REF);
  check(!("earlier" in (appToday.json ?? {})) && !((appToday.json?.matches ?? []) as { id: string }[]).some((x) => x.id === BY.id), "app: without ?earlier=1, today only", Object.keys(appToday.json ?? {}));
  const appEarlier = await http("GET", `/api/mobile/v1/referee/tournaments/${BOYS}/matches?earlier=1`, REF);
  const days = (appEarlier.json?.earlier ?? []) as { day: string; matches: { id: string; score?: string | null }[] }[];
  check(days[0]?.day === shift(today, -1) && days[0].matches.some((x) => x.id === BY.id && x.score === "6-4 6-3"), "app: ?earlier=1 adds earlier[] { day, matches[] with score }", days);

  section("Switching courts is never blocked: the old court keeps its unsent / unfinished matches only");
  const sw = await http("POST", "/api/mobile/v1/staff/session", {}, { code: C2.code, pin: PIN, previousToken: String(s1.json?.token), pendingMatchIds: [B0.id], openMatchIds: [B0.id, BF.id] });
  const carry = sw.json?.carry as { token: string; matchIds: string[]; court: string } | null;
  check(sw.status === 200 && (sw.json?.court as { name: string } | null)?.name === "Court 2" && carry?.court === "Court 1" && JSON.stringify(carry?.matchIds) === JSON.stringify([B0.id]), "app: Court 2's code signs in, with a carry-over for Court 1's unfinished match only (not the finished one)", sw.json);
  const T2: Who = bearer(String(sw.json?.token));
  const withCarry: Who = { ...T2, "X-Staff-Carry": String(carry?.token) };
  const before = new Date().toISOString();
  const { n: n0, state: st0 } = await lastEvent(B0.id);
  const p2 = awardPoint(st0 as ScoreState, "B", DEFAULT_SCORING_CONFIG);
  const carried = await sendEvents(B0.id, withCarry, [scoreEvent(n0 + 1, "POINT_AWARDED", st0, p2, { team_id: B0.team_b_id })], dev);
  check(carried.status === 200, "the old court's match takes its points with the carry-over", carried.text.slice(0, 160));
  const noCarry = await sendEvents(B0.id, T2, [scoreEvent(n0 + 2, "POINT_AWARDED", p2, awardPoint(p2, "B", DEFAULT_SCORING_CONFIG), { team_id: B0.team_b_id })], dev);
  check(noCarry.status === 404, "…but not with the new court's code alone", noCarry.status);
  const newOld = await http("POST", `/api/matches/${G1.id}/claim`, withCarry, { deviceId: `${dev}-g1`, deviceLabel: "x" });
  check(newOld.status === 404, "the carry-over never reaches another (new) Court 1 match", newOld.status);
  const carryAlone = await http("GET", `/api/mobile/v1/referee/matches/${B0.id}/bootstrap`, bearer(String(carry?.token)));
  check(carryAlone.status === 200, "bootstrap of the carried match works with the carry-over", carryAlone.status);
  const carryList = await http("GET", `/api/mobile/v1/referee/tournaments/${BOYS}/matches`, bearer(String(carry?.token)));
  check(carryList.status === 404, "a carry-over alone lists nothing (it reaches its matches only)", carryList.status);
  const court2 = await http("POST", `/api/matches/${B1.id}/claim`, T2, { deviceId: `${dev}-b1`, deviceLabel: "x" });
  check(court2.status === 200, "the new court's own match (B1, now on Court 2) can be scored", court2.status);
  const { data: carriedAudit } = await db().from("audit_logs").select("actor_user_id").eq("entity_id", B0.id).gte("created_at", before);
  const actors = [...new Set(((carriedAudit ?? []) as { actor_user_id: string | null }[]).map((a) => a.actor_user_id))];
  check(actors.every((a) => a === `code:${C1.id}`), "a carried match's audit rows name the old court's code", actors);
  const webCarry = await http("GET", `/referee/matches/${B0.id}/score`, { Cookie: `mb_session=${String(sw.json?.token)}; mb_carry=${String(carry?.token)}` });
  check(webCarry.status === 200, "web: the carry-over cookie opens the old court's match", webCarry.status);
  const webCarryHome = await http("GET", "/referee", { Cookie: `mb_session=${String(sw.json?.token)}; mb_carry=${String(carry?.token)}` });
  check(webCarryHome.text.includes('data-testid="carried"') && webCarryHome.text.includes(B0.id), "web: the court list shows 'Still yours from your last court'", webCarryHome.status);
  const none = await http("POST", "/api/mobile/v1/staff/session", {}, { code: C2.code, pin: PIN, previousToken: String(s1.json?.token), pendingMatchIds: [], openMatchIds: [BF.id, B1.id] });
  check(none.status === 200 && none.json?.carry === null, "nothing to carry (finished, or reached by the new code): no carry-over", none.json?.carry);
  const old = await http("POST", "/api/mobile/v1/staff/session", {}, { code: `${C2.code} ${PIN}` });
  check(old.status === 200 && old.json?.carry === null, "1.0.1's call (code and PIN in its one field) signs in, no carry", old.status);
  await db().from("matches").update({ status: "completed", ended_at: new Date(Date.now() - 31 * 60_000).toISOString() }).eq("id", B0.id);
  const lapsed = await http("GET", `/api/mobile/v1/referee/matches/${B0.id}/bootstrap`, withCarry);
  check(lapsed.status === 404, "the carry-over lapses by itself 30 minutes after the match finished", lapsed.status);
  await db().from("matches").update({ status: "live", ended_at: null }).eq("id", B0.id);

  section("Admin: a new code for one court");
  const C3 = codes.find((c) => c.court_name === "Court 3")!;
  const regen = await callAction("src/app/admin/org/codes/courts/actions.ts", "regenerateCourtCodeAction", [form({ code_id: C3.id })], ADMIN);
  const { data: c3s } = await db().from("organization_codes").select("id, revoked_at, court_name, expires_at").eq("event_group_id", made.group).eq("court_name", "Court 3");
  made.codes.push(...((c3s ?? []) as { id: string }[]).map((c) => c.id));
  check(actionOk(regen) && (c3s ?? []).length === 2 && (c3s ?? []).filter((c) => !(c as { revoked_at: string | null }).revoked_at).length === 1, "the old Court 3 code is revoked and one new one works", c3s);

  section("Revoked: the next request fails");
  const rev = await callAction("src/app/admin/org/codes/actions.ts", "revokeEventCode", [form({ code_id: C1.id })], ADMIN);
  check(actionOk(rev), "revokeEventCode", `${rev.status} ${rev.text.slice(0, 120)}`);
  const after = await http("GET", "/api/mobile/v1/referee/tournaments", REF);
  check(after.status === 401 && after.json?.code === "code_revoked", "the app's next request: 401 code_revoked", after.json);
  const afterEv = await sendEvents(B0.id, REF, [scoreEvent(3, "POINT_AWARDED", p1, awardPoint(p1, "A", DEFAULT_SCORING_CONFIG) as ScoreState, { team_id: B0.team_a_id })], dev);
  check(afterEv.status === 401, "…and its points are refused with 401 (the phone keeps them queued)", afterEv.status);
  const webAfter = await http("GET", "/referee", cookie(webToken));
  check([302, 303, 307].includes(webAfter.status) || /NEXT_REDIRECT|\/login/.test(webAfter.text), "the web console is sent to the login", webAfter.status);
  const page2 = await http("GET", `/admin/org/codes/courts?event=${BOYS}`, ADMIN);
  const page2Text = page2.text.replace(/<!-- -->/g, "");
  check(page2Text.includes("1 ended") && page2Text.includes("Create a code for every court (1)"), "the list shows the revoked code ended, and one court to make again", page2.status);
}

main()
  .catch((e) => check(false, "court-codes threw", String(e?.stack ?? e)))
  .finally(async () => {
    if (made.codes.length) {
      await db().from("audit_logs").delete().in("entity_id", made.codes);
      await db().from("audit_logs").delete().in("actor_user_id", made.codes.map((id) => `code:${id}`));
    }
    if (made.referee) {
      await db().from("audit_logs").delete().eq("actor_referee_id", made.referee);
      await db().from("referee_sessions").delete().eq("referee_id", made.referee);
    }
    await db().from("organization_codes").delete().eq("event_group_id", made.group ?? "00000000-0000-4000-8000-000000000000");
    if (made.referee) await db().from("referees").delete().eq("id", made.referee);
    const ok = await f.cleanup();
    if (made.group) await db().from("event_groups").delete().eq("id", made.group);
    await db().from("request_counters").delete().like("bucket_key", "staff-%");
    check(ok, "cleanup: every row made here is gone");
    finish("court-codes");
  });
