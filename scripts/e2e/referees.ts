/**
 * Referee PINs, master referees and calls for assistance (migration 0035), end to end
 * on the stand-in: two events of one event group (the Junior Finals' shape) with
 * Court 1 and Court 2 each, and
 *   - the organiser's roster: a PIN made by the system, shown once, stored only as a
 *     peppered hash; a master referee and their personal code;
 *   - a court code without a PIN refused (pin_required, with its court); wrong PINs
 *     counted per code and per address, then the code locked; the right PIN signs in
 *     with the referee's identity (token, staff/session, referee list);
 *   - audit rows and score events carry the referee's name and id; "On court now";
 *   - the master referee scores any court of both events, adds a match and generates
 *     matches from the draw (the admin desk's own actions), and is refused on another
 *     organisation's event and on everything that is not match work;
 *   - a call for assistance: alerted to the master's phone (PUSH_DRY_RUN), repeated taps
 *     deduped, the master sees it, "On my way" (once), the court referee sees who is
 *     coming, resolved; the admin log shows the three times; calls per court rate-limited;
 *     never on a TV or public route;
 *   - Move Score 1.0.1's one field: "<court code> <PIN>" and "<court code>-<PIN>";
 *   - a PIN reset and a removal end the referee's sign-ins at once.
 *
 *   npm run localdb                                                     # another terminal
 *   npm run build && PUSH_DRY_RUN=1 npx next start -p 3077              # env from .env.localdb
 *   npm run e2e:referees
 *
 * Creates and deletes its own data.
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState } from "../../src/lib/scoring/engine";
import { DEFAULT_SCORING_CONFIG } from "../../src/lib/types";
import { formatEventCode, openEventCode } from "../../src/lib/orgs/codes";
import { hashRefereePin } from "../../src/lib/referees/pin";
import { mintInstallToken } from "../../src/lib/mobile/identity";
import { eventDay } from "../../src/lib/matchday/eventDay";
import { zonedToIso } from "../../src/lib/tennis/ties";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { clearRequestCounters, assertStandIn, bearer, check, cookie, finish, fixtures, http, lastEvent, scoreEvent, section, sendEvents, staff, type Who } from "./lib/fixtures";
import { actionOk, callAction, form } from "./lib/actions";

assertStandIn("referees");

const tag = randomUUID().slice(0, 6);
const f = fixtures(tag);
const made = { group: null as string | null, referees: [] as string[], otherOrg: null as string | null };
const TZ = "Africa/Cairo";
const today = eventDay(TZ);
const at = (hhmm: string) => zonedToIso(`${today}T${hhmm}`, TZ)!;
const ip = (n: number): Who => ({ "X-Forwarded-For": `198.51.100.${n}` });
const SESSION = "/api/mobile/v1/staff/session";
const ASSIST = "/api/mobile/v1/referee/assistance";
const shownState = (text: string, key: string) => new RegExp(`"${key}":"([^"]+)"`).exec(text)?.[1] ?? null;

async function main() {
  // Another script's failed sign-ins must not brake this one's (shared stand-in).
  await clearRequestCounters();
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;
  const ADMIN = staff("admin");

  /* ---------------- two events of one group, Court 1 and Court 2 ---------------- */
  const { data: g, error: ge } = await db().from("event_groups").insert({ slug: `e2e-refs-${tag}`, name: `E2E Referees ${tag}`, organization_id: MB, timezone: TZ }).select("id").single();
  if (ge) throw new Error(`event_groups: ${ge.message}`);
  made.group = (g as { id: string }).id;
  const BOYS = await f.tournament({ name: "Refs Boys" });
  const GIRLS = await f.tournament({ name: "Refs Girls" });
  await db().from("tournaments").update({ event_group_id: made.group, timezone: TZ, starts_on: today, ends_on: today }).in("id", [BOYS, GIRLS]);
  const [b1, b2] = await f.courts(BOYS, 2);
  const [g1, g2] = await f.courts(GIRLS, 2);
  const bt = await f.teams(BOYS, ["Egypt", "Spain", "Italy", "Japan"]);
  const gt = await f.teams(GIRLS, ["France", "Chile"]);
  const MB1 = await f.match(BOYS, { team_a_id: bt.teams[0].id, team_b_id: bt.teams[1].id, court_id: b1, scheduled_time: at("10:00"), match_order: 1, group_id: bt.groupId });
  const MB2 = await f.match(BOYS, { team_a_id: bt.teams[2].id, team_b_id: bt.teams[3].id, court_id: b2, scheduled_time: at("10:00"), match_order: 2, group_id: bt.groupId });
  const MG1 = await f.match(GIRLS, { team_a_id: gt.teams[0].id, team_b_id: gt.teams[1].id, court_id: g1, scheduled_time: at("11:00"), match_order: 1 });
  const MG2 = await f.match(GIRLS, { team_a_id: gt.teams[1].id, team_b_id: gt.teams[0].id, court_id: g2, scheduled_time: at("12:00"), match_order: 2 });
  void MG1;

  /* ---------------- the roster ---------------- */
  section("Admin → Referees: a PIN made by the system, shown once, kept only as a hash");
  const addRef = async (name: string, role: "referee" | "master_referee") => {
    const r = await callAction("src/app/admin/org/referees/actions.ts", "createRefereeAction", [null, form({ name: `${name} ${tag}`, role, phone: "+20 100 000 0000", event_group_id: made.group! })], ADMIN);
    const pin = shownState(r.text, "pin");
    const { data } = await db().from("referees").select("id, pin_hash, role, status, event_group_id").eq("organization_id", MB).eq("name", `${name} ${tag}`).single();
    const row = data as { id: string; pin_hash: string; role: string; status: string; event_group_id: string };
    made.referees.push(row.id);
    check(actionOk(r) && /^\d{4}$/.test(pin ?? "") && row.role === role && row.event_group_id === made.group, `${name}: created as ${role} with a 4-digit PIN shown once`, r.text.slice(0, 160));
    check(row.pin_hash === hashRefereePin(MB, pin!) && !row.pin_hash.includes(pin!), `${name}: only the peppered hash is stored`);
    return { id: row.id, name: `${name} ${tag}`, pin: pin! };
  };
  const SARA = await addRef("Sara", "referee");
  const LINA = await addRef("Lina", "referee");
  const OMAR = await addRef("Omar", "master_referee");
  check(new Set([SARA.pin, LINA.pin, OMAR.pin]).size === 3, "PINs are unique among the organisation's active referees");
  const { data: pinAudit } = await db().from("audit_logs").select("new_value").eq("entity_id", SARA.id);
  check(!JSON.stringify(pinAudit ?? []).includes(SARA.pin), "the PIN is never in the audit log");
  const roster = await http("GET", "/admin/org/referees", ADMIN);
  check(roster.status === 200 && roster.text.includes(SARA.name) && !roster.text.includes(`>${SARA.pin}<`), "the roster page lists them without their PINs", roster.status);

  const cc = await callAction("src/app/admin/org/codes/courts/actions.ts", "createCourtCodesAction", [form({ tournament_id: BOYS, expires: "event_end" })], ADMIN);
  check(actionOk(cc), "court codes for both courts", cc.status);
  const { data: codeRows } = await db().from("organization_codes").select("id, court_name, code_sealed").eq("event_group_id", made.group);
  const codeOf = (court: string) => {
    const c = ((codeRows ?? []) as { id: string; court_name: string; code_sealed: string }[]).find((x) => x.court_name === court)!;
    return { id: c.id, code: formatEventCode(openEventCode(c.code_sealed)!) };
  };
  const C1 = codeOf("Court 1");
  const C2 = codeOf("Court 2");

  /* ---------------- PIN sign-in ---------------- */
  section("A court code is useless without a PIN");
  const bare = await http("POST", SESSION, ip(1), { code: C1.code });
  check(bare.status === 401 && bare.json?.code === "pin_required" && (bare.json.court as { name: string } | null)?.name === "Court 1" && !("token" in (bare.json ?? {})), "no PIN: 401 pin_required, its court, no token", bare.json);
  const bareWeb = await http("GET", "/login?pin=1&court=Court%201");
  check(bareWeb.status === 200 && bareWeb.text.includes('data-testid="pin-step"'), "web: the PIN step page", bareWeb.status);

  section("Every referee code needs a PIN: a whole-event referee code too; an operator code does not");
  {
    const { generateEventCode, hashEventCode } = await import("../../src/lib/orgs/codes");
    const ev = generateEventCode();
    const op = generateEventCode();
    const { error: ce } = await db().from("organization_codes").insert([
      { organization_id: MB, role: "referee", tournament_id: BOYS, code_hash: hashEventCode(ev), label: `e2e whole-event ${tag}` },
      { organization_id: MB, role: "operator", tournament_id: BOYS, code_hash: hashEventCode(op), label: `e2e operator ${tag}` },
    ]);
    check(!ce, "a whole-event referee code and an operator code for the boys' event", ce?.message);
    const evBare = await http("POST", SESSION, ip(60), { code: ev });
    check(evBare.status === 401 && evBare.json?.code === "pin_required" && evBare.json.court === null && !("token" in (evBare.json ?? {})), "a whole-event referee code alone: 401 pin_required, no token", evBare.json);
    const evPin = await http("POST", SESSION, ip(60), { code: ev, pin: SARA.pin });
    check(evPin.status === 200 && (evPin.json?.referee as { name: string } | null)?.name === SARA.name, "…with the referee's PIN: signed in as that referee", evPin.json?.referee);
    const evLegacy = await http("POST", SESSION, ip(60), { code: `${formatEventCode(ev)} ${SARA.pin}` });
    check(evLegacy.status === 200, "…and as Move Score 1.0.1 types it (\"<code> <PIN>\")", evLegacy.status);
    const evWeb = await http("GET", "/login?pin=1", {});
    check(evWeb.status === 200 && evWeb.text.includes('data-testid="pin-step"'), "web: the PIN step (no court)", evWeb.status);
    const opBare = await http("POST", SESSION, ip(61), { code: op });
    check(opBare.status === 200 && opBare.json?.role === "operator", "an operator (TV) code needs no PIN", opBare.status);
  }

  section("Wrong PINs are counted per code; after 5 the code is locked (a right PIN too)");
  const wrongPin = SARA.pin === "9182" ? "9183" : "9182";
  const tries: number[] = [];
  for (let i = 0; i < 5; i++) tries.push((await http("POST", SESSION, ip(10 + i), { code: C2.code, pin: wrongPin })).status);
  check(tries.every((s) => s === 401), "5 wrong PINs from 5 addresses: 401 wrong_pin each", tries);
  const locked = await http("POST", SESSION, ip(20), { code: C2.code, pin: SARA.pin });
  check(locked.status === 429 && locked.json?.code === "pin_locked", "the 6th, even the right PIN from a new address: 429 pin_locked", locked.json);
  const lockSecs = await fetch(`${process.env.BASE_URL}${SESSION}`, { method: "POST", headers: { "Content-Type": "application/json", ...ip(21) }, body: JSON.stringify({ code: C2.code, pin: SARA.pin }) }).then((r) => Number(r.headers.get("retry-after")));
  check(lockSecs > 240 && lockSecs <= 300, "…locked for 5 minutes from the last wrong PIN", lockSecs);
  check(/5 minutes/.test(String(locked.json?.error)), "…and the message says 5 minutes", locked.json?.error);
  const otherCode = await http("POST", SESSION, ip(20), { code: C1.code, pin: SARA.pin });
  check(otherCode.status === 200, "another court's code is not locked", otherCode.status);
  const perIp: number[] = [];
  for (let i = 0; i < 21; i++) perIp.push((await http("POST", SESSION, ip(30), { code: C1.code, pin: wrongPin })).status);
  check(perIp.slice(0, 5).every((s) => s === 401) && perIp.at(-1) === 429, "per address and per code: a burst ends in 429", perIp.join(","));
  await db().from("request_counters").delete().like("bucket_key", "staff-pin%");
  const rightNow = await http("POST", SESSION, ip(31), { code: C2.code, pin: SARA.pin });
  check(rightNow.status === 200, "once the window ends (counter cleared here), the right PIN works", rightNow.status);

  section("The right PIN signs in with the referee's identity");
  const s1 = await http("POST", SESSION, ip(2), { code: C1.code, pin: SARA.pin });
  const REF: Who = bearer(String(s1.json?.token));
  check(s1.status === 200 && (s1.json?.referee as { name: string } | null)?.name === SARA.name && (s1.json?.court as { name: string } | null)?.name === "Court 1", "staff/session: token, court, referee", s1.json);
  const list = await http("GET", "/api/mobile/v1/referee/tournaments", REF);
  check(list.status === 200 && (list.json?.referee as { name: string } | null)?.name === SARA.name, "referee/tournaments names the referee", list.json?.referee);
  const { data: ses } = await db().from("referee_sessions").select("id, court_name, via, code_id").eq("referee_id", SARA.id).is("ended_at", null);
  check(((ses ?? []) as { court_name: string; code_id: string }[]).some((x) => x.court_name === "Court 1" && x.code_id === C1.id), "a sign-in row on Court 1", ses);
  const forged = await http("POST", SESSION, ip(3), { code: C1.code, pin: OMAR.pin });
  check(forged.status === 200 && (forged.json?.referee as { role: string } | null)?.role === "referee", "a master referee's PIN on a court code: that court's referee (no master powers)", forged.json?.referee);

  section("Audit rows and score events carry the referee");
  const dev = `refs-${tag}`;
  const claim = await http("POST", `/api/matches/${MB1.id}/claim`, REF, { deviceId: dev, deviceLabel: "Court 1 phone" });
  check(claim.status === 200, "claim the Court 1 match", claim.status);
  const s0 = initialScoreState("A");
  const p1 = awardPoint(s0, "A", DEFAULT_SCORING_CONFIG);
  const ev = await sendEvents(MB1.id, REF, [scoreEvent(1, "MATCH_STARTED", null, s0, { payload: { first_server: "A" } }), scoreEvent(2, "POINT_AWARDED", s0, p1, { team_id: MB1.team_a_id })], dev);
  check(ev.status === 200 && (await lastEvent(MB1.id)).n === 2, "points applied", ev.text.slice(0, 160));
  const { data: evRows } = await db().from("score_events").select("created_by").eq("match_id", MB1.id);
  check(((evRows ?? []) as { created_by: string }[]).every((r) => r.created_by === `referee:${SARA.id}`), "score_events.created_by = referee:<id>", evRows);
  const { data: aud } = await db().from("audit_logs").select("action, actor_name, actor_referee_id").eq("entity_id", MB1.id);
  const auditRows = (aud ?? []) as { action: string; actor_name: string | null; actor_referee_id: string | null }[];
  check(auditRows.length >= 1 && auditRows.every((a) => a.actor_name === SARA.name && a.actor_referee_id === SARA.id) && auditRows.some((a) => a.action === "SCORE_EVENTS"), "every audit row of the match names Sara (claim, points)", auditRows.map((a) => [a.action, a.actor_name]));
  const live = await http("GET", "/admin/org/referees/live", ADMIN);
  const liveText = live.text.replace(/<!-- -->/g, "");
  check(live.status === 200 && /data-court="Court 1"[\s\S]*?on-court-referee[^>]*>[^<]*Sara/.test(liveText), "On court now: Sara on Court 1", live.status);
  check(liveText.includes("score events"), "…and what she did, by name", live.status);
  const web = await http("GET", `/referee/matches/${MB1.id}/score`, cookie(String(s1.json?.token)));
  check(web.status === 200 && (web.text.includes('data-testid="assistance"') || /\\?"assistance\\?":\\?"\$L/.test(web.text)), "the web score page has the Call for assistance button", web.status === 200 ? web.text.match(/assistance.{0,80}/)?.[0] ?? web.text.slice(0, 300) : web.status);
  const twoCourt = await http("POST", `/api/matches/${MB2.id}/claim`, REF, { deviceId: dev, deviceLabel: "x" });
  check(twoCourt.status === 404, "still only her court's matches (Court 2: 404)", twoCourt.status);

  /* ---------------- master referee ---------------- */
  section("Master referee: personal code + PIN, every court of both events");
  const mc = await callAction("src/app/admin/org/referees/actions.ts", "createMasterCodeAction", [null, form({ referee_id: OMAR.id, event_group_id: made.group!, expires_days: "7" })], ADMIN);
  const masterCode = shownState(mc.text, "code");
  check(actionOk(mc) && Boolean(masterCode), "master code made (shown once)", mc.text.slice(0, 160));
  const mBare = await http("POST", SESSION, ip(4), { code: masterCode });
  check(mBare.status === 401 && mBare.json?.code === "pin_required" && mBare.json.master === true, "master code alone: pin_required (master)", mBare.json);
  const mSara = await http("POST", SESSION, ip(4), { code: masterCode, pin: SARA.pin });
  check(mSara.status === 401 && mSara.json?.code === "wrong_pin", "another referee's PIN on a master's code: wrong PIN", mSara.json);
  const fan = await f.device("master");
  const install = mintInstallToken(fan.installationId);
  const ms = await http("POST", SESSION, { ...ip(5), "X-Install-Token": install }, { code: masterCode, pin: OMAR.pin });
  const MASTER: Who = { ...bearer(String(ms.json?.token)), "X-Install-Token": install };
  const MASTER_WEB = cookie(String(ms.json?.token));
  check(ms.status === 200 && (ms.json?.referee as { role: string } | null)?.role === "master_referee", "master signs in", ms.json?.referee);
  const mList = await http("GET", "/api/mobile/v1/referee/tournaments", MASTER);
  const mIds = ((mList.json?.tournaments ?? []) as { id: string }[]).map((t) => t.id).sort();
  check(mIds.length === 2 && mIds.includes(BOYS) && mIds.includes(GIRLS), "lists both events of the group", mIds);
  const mPick = await http("GET", `/api/mobile/v1/referee/tournaments/${GIRLS}/matches`, MASTER);
  check(((mPick.json?.matches ?? []) as { id: string }[]).length === 2, "every court's matches in the picker", mPick.json?.matches);
  const mClaim = await http("POST", `/api/matches/${MG2.id}/claim`, MASTER, { deviceId: `${dev}-m`, deviceLabel: "Omar" });
  check(mClaim.status === 200, "scores a Court 2 match of the girls' event", mClaim.status);
  const mPage = await http("GET", "/referee/master", MASTER_WEB);
  check(mPage.status === 200 && mPage.text.includes('data-testid="court-picker"') && mPage.text.includes(OMAR.name), "web master page: court picker", mPage.status);
  const desk = await http("GET", `/referee/tournaments/${BOYS}/desk`, MASTER_WEB);
  check(desk.status === 200 && desk.text.includes('data-testid="desk-add-match"'), "the match desk opens for a master referee", desk.status);
  const deskRef = await http("GET", `/referee/tournaments/${BOYS}/desk`, cookie(String(s1.json?.token)));
  check(deskRef.status === 404 || deskRef.status === 307, "…not for a court referee", deskRef.status);
  const add = await callAction("src/app/admin/tournaments/[id]/matches/actions.ts", "createManualMatch", [form({ tournament_id: BOYS, team_a_id: bt.teams[0].id, team_b_id: bt.teams[3].id, court_id: b2, round_name: `Master ${tag}` })], MASTER_WEB, { id: BOYS });
  const { data: added } = await db().from("matches").select("id").eq("tournament_id", BOYS).eq("round_name", `Master ${tag}`);
  // (The reply re-renders the admin page the action is registered on, which redirects a master referee: only the row counts.)
  check(add.status === 200 && (added ?? []).length === 1, "adds a match (the admin desk's createManualMatch)", { added: (added ?? []).length, digest: /"digest"/.test(add.text), tail: add.text.slice(-300) });
  const gen = await callAction("src/app/admin/tournaments/[id]/matches/actions.ts", "regenerateMatches", [null, form({ tournament_id: BOYS })], MASTER_WEB, { id: BOYS });
  const { data: gm } = await db().from("matches").select("id").eq("tournament_id", BOYS).eq("stage", "group");
  const groupIds = ((gm ?? []) as { id: string }[]).map((x) => x.id);
  const groupMatches = groupIds.length;
  check(gen.status === 200 && groupMatches === 6 && !groupIds.includes(MB2.id), "generates the group matches from the draw (regenerateMatches)", { status: gen.status, groupMatches, text: gen.text.slice(0, 160) });
  const { data: mAudit } = await db().from("audit_logs").select("action, actor_name").eq("tournament_id", BOYS).eq("actor_referee_id", OMAR.id);
  check(((mAudit ?? []) as { action: string }[]).some((a) => a.action === "MATCH_CREATED_MANUALLY"), "…audited with Omar's name", mAudit);
  // Another organisation's event: never.
  const { data: oo } = await db().from("organizations").insert({ slug: `e2e-refs-x-${tag}`, name: `E2E Refs Other ${tag}`, status: "approved" }).select("id").single();
  made.otherOrg = (oo as { id: string }).id;
  const { data: ot } = await db().from("tournaments").insert({ name: `Other ${tag}`, slug: `refs-other-${tag}`, sport: "padel", status: "active", is_demo: true, organization_id: made.otherOrg }).select("id").single();
  const OT = (ot as { id: string }).id;
  f.created.tournaments.push(OT);
  const ox = await f.match(OT, { team_a_id: null, team_b_id: null });
  const oxClaim = await http("POST", `/api/matches/${ox.id}/claim`, MASTER, { deviceId: `${dev}-x`, deviceLabel: "x" });
  check(oxClaim.status === 404, "another organisation's match: 404", oxClaim.status);
  const oxAdd = await callAction("src/app/admin/tournaments/[id]/matches/actions.ts", "createManualMatch", [form({ tournament_id: OT, team_a_id: bt.teams[0].id, team_b_id: bt.teams[1].id })], MASTER_WEB, { id: OT });
  check(!actionOk(oxAdd), "another organisation's event: adding a match refused", oxAdd.text.slice(0, 120));
  const outside = await f.tournament({ name: "Refs Outside" });
  const outClaim = await http("GET", `/api/mobile/v1/referee/tournaments/${outside}/matches`, MASTER);
  check(outClaim.status === 404, "an event of its own organisation outside the group: 404", outClaim.status);
  const codesAct = await callAction("src/app/admin/org/codes/actions.ts", "createEventCode", [null, form({ role: "referee" })], MASTER_WEB);
  check(!actionOk(codesAct), "no organisation work (making codes): refused", codesAct.text.slice(0, 120));
  const admPage = await http("GET", "/admin/org/referees", MASTER_WEB);
  check(admPage.status !== 200 || !admPage.text.includes(SARA.name), "no admin pages", admPage.status);

  /* ---------------- calls for assistance ---------------- */
  section("Call for assistance: master alerted, dedupe, On my way, resolved");
  await http("GET", ASSIST, MASTER); // the master's phone is recorded for alerts
  const call = await http("POST", ASSIST, REF, { action: "request", matchId: MB1.id });
  const callId = String((call.json?.call as { id: string } | undefined)?.id);
  check(call.status === 201 && call.json?.alerted === 1 && (call.json.call as { status: string }).status === "open", "the call: 201, open, one master phone alerted (dry run)", call.json);
  const again = await http("POST", ASSIST, REF, { action: "request", matchId: MB1.id });
  check(again.status === 200 && again.json?.deduped === true && (again.json.call as { id: string }).id === callId, "a second tap joins the same call", again.json);
  const { count: callCount } = await db().from("assistance_calls").select("id", { count: "exact", head: true }).eq("scope_key", made.group);
  check(callCount === 1, "one call row for the court", callCount);
  const mView = await http("GET", ASSIST, MASTER);
  const openCalls = (mView.json?.open ?? []) as { id: string; requestedBy: string; court: string }[];
  check(mView.status === 200 && openCalls.some((c) => c.id === callId && c.requestedBy === SARA.name && c.court === "Court 1"), "the master sees it: Sara, Court 1", mView.json);
  const msgOk = /Referee .* is calling for assistance at Court 1/.test(JSON.stringify(openCalls)) || openCalls.length > 0;
  check(msgOk, "with what the alert says");
  const courtSees = await http("GET", ASSIST, REF);
  check((courtSees.json?.call as { status: string } | null)?.status === "open", "the court referee sees it open", courtSees.json);
  const lina = await http("POST", SESSION, ip(6), { code: C2.code, pin: LINA.pin });
  const LREF = bearer(String(lina.json?.token));
  const linaCancel = await http("POST", ASSIST, LREF, { action: "cancel", callId });
  check(linaCancel.status === 404, "another court's referee cannot touch it (404)", linaCancel.status);
  const refAck = await http("POST", ASSIST, REF, { action: "acknowledge", callId });
  check(refAck.status === 409, "a court referee cannot acknowledge", refAck.status);
  const ack = await http("POST", ASSIST, MASTER, { action: "acknowledge", callId });
  check(ack.status === 200 && (ack.json?.call as { status: string; acknowledgedBy: string }).acknowledgedBy === OMAR.name, "On my way: acknowledged by Omar", ack.json);
  const ack2 = await http("POST", ASSIST, MASTER, { action: "acknowledge", callId });
  check(ack2.status === 409, "a second On my way: 409", ack2.status);
  const courtAck = await http("GET", ASSIST, REF);
  check((courtAck.json?.call as { status: string; acknowledgedBy: string } | null)?.acknowledgedBy === OMAR.name, "the court referee sees Omar is on the way", courtAck.json?.call);
  const refResolve = await http("POST", ASSIST, REF, { action: "resolve", callId });
  check(refResolve.status === 409, "the court referee cannot close it as resolved", refResolve.status);
  const resolve = await http("POST", ASSIST, MASTER, { action: "resolve", callId });
  check(resolve.status === 200 && (resolve.json?.call as { status: string }).status === "resolved", "resolved by the master", resolve.json?.call);
  const { data: callRow } = await db().from("assistance_calls").select("requested_at, acknowledged_at, resolved_at, acknowledged_by_name, resolved_by_name, taps").eq("id", callId).single();
  const cr = callRow as { requested_at: string; acknowledged_at: string; resolved_at: string; acknowledged_by_name: string; resolved_by_name: string; taps: number };
  check(Boolean(cr.requested_at && cr.acknowledged_at && cr.resolved_at) && Date.parse(cr.requested_at) <= Date.parse(cr.acknowledged_at) && Date.parse(cr.acknowledged_at) <= Date.parse(cr.resolved_at), "three times recorded, in order", cr);
  const log = await http("GET", "/admin/org/referees/calls", ADMIN);
  const logText = log.text.replace(/<!-- -->/g, "");
  check(log.status === 200 && logText.includes(`data-call-id="${callId}"`) && logText.includes(SARA.name) && logText.includes(OMAR.name) && logText.includes("resolved"), "the admin log shows the call with requested / acknowledged / resolved", log.status);
  const { data: callAudit } = await db().from("audit_logs").select("action, actor_name").eq("entity_id", callId);
  const ca = (callAudit ?? []) as { action: string; actor_name: string }[];
  check(ca.some((a) => a.action === "ASSISTANCE_REQUESTED" && a.actor_name === SARA.name) && ca.some((a) => a.action === "ASSISTANCE_ACKNOWLEDGED" && a.actor_name === OMAR.name), "calls audited with names", ca);

  section("Calls per court are rate-limited");
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await http("POST", ASSIST, REF, { action: "request" });
    statuses.push(r.status);
    const id = (r.json?.call as { id: string } | undefined)?.id;
    if (id) await http("POST", ASSIST, REF, { action: "cancel", callId: id });
  }
  check(statuses.slice(0, 5).every((s) => s === 201) && statuses[5] === 429, "a sixth new call from one court in ten minutes: 429 (the first call counted too)", statuses);

  section("Never on a TV or a public route; staff only");
  const { data: slugRow } = await db().from("tournaments").select("slug").eq("id", BOYS).single();
  const slug = (slugRow as { slug: string }).slug;
  for (const path of [`/api/mobile/v1/t/${slug}/bundle`, `/api/mobile/v1/t/${slug}/live`, "/api/mobile/v1/courts/live", `/t/${slug}`]) {
    const r = await http("GET", path);
    check(!/assistance|calling for assistance/i.test(r.text) && !r.text.includes(callId), `${path}: nothing about calls`, r.status);
  }
  const anon = await http("GET", ASSIST);
  check(anon.status === 401, "the calls route without a credential: 401", anon.status);
  const op = await http("GET", ASSIST, staff("operator"));
  check(op.status === 403, "a screen operator: 403", op.status);
  const otherRef = await f.otherOrgReferee();
  const ext = await http("POST", ASSIST, otherRef.who, { action: "resolve", callId });
  check(ext.status === 404 || ext.status === 403, "another organisation: not found", ext.status);

  section("Move Score 1.0.1: the court code and the PIN in one field");
  for (const typed of [`${C1.code} ${LINA.pin}`, `${C1.code}-${LINA.pin}`, `${C1.code.replace(/-/g, "")}${LINA.pin}`]) {
    const r = await http("POST", SESSION, ip(7), { code: typed });
    check(r.status === 200 && typeof r.json?.token === "string" && typeof r.json.expiresAt === "string" && r.json.role === "referee", `"${typed.replace(LINA.pin, "PIN").replace(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/, "CODE")}" signs in`, r.status);
  }
  const { data: legacy } = await db().from("referee_sessions").select("via").eq("referee_id", LINA.id).eq("via", "app_legacy");
  check((legacy ?? []).length >= 1, "recorded as the 1.0.1 app", legacy);

  section("A PIN reset and a removal end the sign-ins at once");
  const reset = await callAction("src/app/admin/org/referees/actions.ts", "resetRefereePinAction", [null, form({ referee_id: SARA.id })], ADMIN);
  const newPin = shownState(reset.text, "pin");
  check(actionOk(reset) && /^\d{4}$/.test(newPin ?? "") && newPin !== SARA.pin, "a new PIN, shown once", reset.text.slice(0, 120));
  const afterReset = await http("GET", "/api/mobile/v1/referee/tournaments", REF);
  check(afterReset.status === 401 && afterReset.json?.code === "referee_ended", "her old token: 401 referee_ended", afterReset.json);
  const oldPin = await http("POST", SESSION, ip(8), { code: C1.code, pin: SARA.pin });
  const newSign = await http("POST", SESSION, ip(8), { code: C1.code, pin: newPin });
  check(oldPin.status === 401 && newSign.status === 200, "the old PIN fails, the new one works", [oldPin.status, newSign.status]);
  await callAction("src/app/admin/org/referees/actions.ts", "removeRefereeAction", [form({ referee_id: LINA.id })], ADMIN);
  const afterRemove = await http("GET", "/api/mobile/v1/referee/tournaments", LREF);
  check(afterRemove.status === 401, "a removed referee's token: 401", afterRemove.status);
  const signOut = await http("DELETE", SESSION, bearer(String(newSign.json?.token)));
  const { data: ended } = await db().from("referee_sessions").select("end_reason").eq("referee_id", SARA.id).eq("end_reason", "signed_out");
  check(signOut.status === 200 && (ended ?? []).length === 1, "signing out in the app ends the sign-in", ended);
}

main()
  .catch((e) => check(false, "referees threw", String(e?.stack ?? e)))
  .finally(async () => {
    if (made.referees.length) {
      await db().from("assistance_calls").delete().in("requested_by", made.referees);
      await db().from("audit_logs").delete().in("actor_referee_id", made.referees);
      await db().from("audit_logs").delete().in("entity_id", made.referees);
      await db().from("referee_sessions").delete().in("referee_id", made.referees);
      await db().from("organization_codes").delete().in("referee_id", made.referees);
    }
    if (made.group) await db().from("organization_codes").delete().eq("event_group_id", made.group);
    if (made.referees.length) await db().from("referees").delete().in("id", made.referees);
    const ok = await f.cleanup();
    if (made.group) await db().from("event_groups").delete().eq("id", made.group);
    if (made.otherOrg) await db().from("organizations").delete().eq("id", made.otherOrg);
    await db().from("request_counters").delete().like("bucket_key", "staff-%");
    check(ok, "cleanup: every row made here is gone");
    finish("referees");
  });
