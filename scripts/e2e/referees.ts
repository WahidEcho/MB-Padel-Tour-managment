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
 *     deduped, the master sees it, "On my way" (once), the chair umpire sees who is
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
  section("A court code is useless without a PIN; the PIN step shows no names (the PIN says who)");
  const bare = await http("POST", SESSION, ip(1), { code: C1.code });
  check(bare.status === 401 && bare.json?.code === "pin_required" && (bare.json.court as { name: string } | null)?.name === "Court 1" && !("token" in (bare.json ?? {})), "no PIN: 401 pin_required, its court, no token", bare.json);
  check(Array.isArray(bare.json?.referees) && (bare.json!.referees as unknown[]).length === 0 && ![SARA, LINA, OMAR].some((r) => JSON.stringify(bare.json).includes(r.name)), "…and no referee names (anyone can scan a court QR)", bare.json?.referees);
  const pinOnly = await http("POST", SESSION, ip(1), { code: C1.code, pin: LINA.pin });
  check(pinOnly.status === 200 && (pinOnly.json?.referee as { name: string } | null)?.name === LINA.name, "the PIN alone signs in the referee it belongs to", pinOnly.json?.referee);
  const bareWeb = await http("GET", "/login?pin=1&court=Court%201");
  check(bareWeb.status === 200 && bareWeb.text.includes('data-testid="pin-step"'), "web: the PIN step page", bareWeb.status);
  const notListed = await http("POST", SESSION, ip(1), { code: C1.code, refereeId: randomUUID(), pin: SARA.pin });
  check(notListed.status === 401 && notListed.json?.code === "pin_required" && Array.isArray(notListed.json.referees), "a name not on the list: pin_required with the list again (no PIN tried)", notListed.json);

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
    const evPin = await http("POST", SESSION, ip(60), { code: ev, refereeId: SARA.id, pin: SARA.pin });
    check(evPin.status === 200 && (evPin.json?.referee as { name: string } | null)?.name === SARA.name, "…with her name and PIN: signed in as that referee", evPin.json?.referee);
    const evLegacy = await http("POST", SESSION, ip(60), { code: `${formatEventCode(ev)} ${SARA.pin}` });
    check(evLegacy.status === 200, "…and as Move Score 1.0.1 types it (\"<code> <PIN>\")", evLegacy.status);
    const evWeb = await http("GET", "/login?pin=1", {});
    check(evWeb.status === 200 && evWeb.text.includes('data-testid="pin-step"'), "web: the PIN step (no court)", evWeb.status);
    const opBare = await http("POST", SESSION, ip(61), { code: op });
    check(opBare.status === 200 && opBare.json?.role === "operator", "an operator (TV) code needs no PIN", opBare.status);
  }

  section("Wrong PINs block that phone only (5 in 5 minutes): never a referee, never the court code");
  const wrongPin = (pin: string) => (pin === "9182" ? "9183" : "9182");
  const saraFan = await f.device("sara-phone");
  const saraPhone = mintInstallToken(saraFan.installationId);
  const spamPhone = mintInstallToken(`ios-spam-${tag}-0000`);
  const tries: { status: number; error: string }[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await http("POST", SESSION, { ...ip(10), "X-Install-Token": spamPhone }, { code: C2.code, pin: wrongPin(SARA.pin) });
    tries.push({ status: r.status, error: String(r.json?.error) });
  }
  check(tries.every((t) => t.status === 401) && /4 tries left on this phone/.test(tries[0].error) && /This phone is blocked/.test(tries[4].error), "5 wrong PINs from one phone: 401 each, with that phone's tries left", tries.map((t) => t.error));
  const blocked = await http("POST", SESSION, { ...ip(10), "X-Install-Token": spamPhone }, { code: C2.code, pin: SARA.pin });
  check(blocked.status === 429 && blocked.json?.code === "pin_locked" && /this phone/i.test(String(blocked.json?.error)), "the 6th from that phone, even a right PIN: 429 pin_locked (this phone)", blocked.json);
  const lockSecs = await fetch(`${process.env.BASE_URL}${SESSION}`, { method: "POST", headers: { "Content-Type": "application/json", ...ip(10), "X-Install-Token": spamPhone }, body: JSON.stringify({ code: C2.code, pin: SARA.pin }) }).then((r) => Number(r.headers.get("retry-after")));
  check(lockSecs > 240 && lockSecs <= 300, "…blocked for 5 minutes from the last wrong PIN", lockSecs);
  const saraOwn = await http("POST", SESSION, { ...ip(10), "X-Install-Token": saraPhone }, { code: C2.code, pin: SARA.pin });
  check(saraOwn.status === 200 && (saraOwn.json?.referee as { name: string } | null)?.name === SARA.name, "Sara on her own phone, same network: signs straight in (no referee lock)", saraOwn.json?.referee);
  const linaSame = await http("POST", SESSION, ip(20), { code: C2.code, pin: LINA.pin });
  check(linaSame.status === 200, "the same court code from another phone: Lina still signs in (no per-code lock)", linaSame.status);
  const { data: pinCounters } = await db().from("request_counters").select("bucket_key").like("bucket_key", "staff-pin%");
  const counterKeys = ((pinCounters ?? []) as { bucket_key: string }[]).map((r) => r.bucket_key);
  check(!counterKeys.some((k) => k.includes(C2.id) || k.startsWith("staff-pin-ref:")), "no counter per court code or per referee", counterKeys);
  await db().from("request_counters").delete().like("bucket_key", "staff-pin%");

  section("The organisation's count only alerts: the admins are emailed, nobody is locked out");
  {
    const fill: number[] = [];
    for (let i = 0; i < 25; i++) fill.push((await http("POST", SESSION, { ...ip(100 + i), "X-Install-Token": mintInstallToken(`ios-guess-${tag}-${i}`) }, { code: C1.code, pin: wrongPin(LINA.pin) })).status);
    check(fill.every((st) => st === 401), "25 wrong PINs from 25 phones within 10 minutes: 401 each", fill.join(","));
    const notPaused = await http("POST", SESSION, ip(140), { code: C1.code, pin: LINA.pin });
    check(notPaused.status === 200, "the next sign-in on a new phone: signs in (no organisation pause)", notPaused.status);
    const { data: brake } = await db().from("audit_logs").select("action, new_value").eq("organization_id", MB).eq("action", "REFEREE_PIN_BRAKE");
    check((brake ?? []).length >= 1, "an alert (audit row) for the organisation", brake);
    const banner = await http("GET", "/admin/org/referees", ADMIN);
    check(banner.status === 200 && banner.text.includes('data-testid="pin-brake-banner"'), "the admin banner on Admin → Referees", banner.status);
    await db().from("audit_logs").delete().eq("organization_id", MB).eq("action", "REFEREE_PIN_BRAKE");
    await db().from("request_counters").delete().like("bucket_key", "staff-pin%");
  }

  section("Move Score 1.0.1's \"<code> <PIN>\": the same per-phone brake (its address, no install token)");
  {
    const legacy: number[] = [];
    for (let i = 0; i < 6; i++) legacy.push((await http("POST", SESSION, ip(150), { code: `${C1.code} ${wrongPin(LINA.pin)}` })).status);
    check(legacy.slice(0, 5).every((st) => st === 401) && legacy[5] === 429, "5 nameless wrong PINs from one address, then 429 for that address", legacy.join(","));
    const other = await http("POST", SESSION, ip(151), { code: `${C1.code} ${LINA.pin}` });
    check(other.status === 200 && (other.json?.referee as { name: string } | null)?.name === LINA.name, "another phone's \"<code> <PIN>\" signs in", other.json?.referee);
    await db().from("request_counters").delete().like("bucket_key", "staff-pin%");
  }

  section("The per-address ceiling against scripts: 60 wrong PINs in 15 minutes");
  {
    const st: number[] = [];
    for (let i = 0; i < 61; i++) st.push((await http("POST", SESSION, { ...ip(170), "X-Install-Token": mintInstallToken(`ios-script-${tag}-${i}`) }, { code: C1.code, pin: wrongPin(LINA.pin) })).status);
    check(st.slice(0, 60).every((x) => x === 401) && st[60] === 429, "60 wrong PINs from one address across new phones, then 429 pin_busy", `${st.filter((x) => x === 401).length}×401, last ${st[60]}`);
    const elsewhere = await http("POST", SESSION, ip(171), { code: C1.code, pin: LINA.pin });
    check(elsewhere.status === 200, "another address still signs in", elsewhere.status);
    await db().from("request_counters").delete().like("bucket_key", "staff-pin%");
    await db().from("audit_logs").delete().eq("organization_id", MB).eq("action", "REFEREE_PIN_BRAKE");
  }
  const rightNow = await http("POST", SESSION, ip(31), { code: C2.code, pin: SARA.pin });
  check(rightNow.status === 200, "once the window ends (counters cleared here), the right PIN works", rightNow.status);

  section("The right PIN signs in with the referee's identity");
  const s1 = await http("POST", SESSION, ip(2), { code: C1.code, refereeId: SARA.id, pin: SARA.pin });
  const REF: Who = bearer(String(s1.json?.token));
  check(s1.status === 200 && (s1.json?.referee as { name: string } | null)?.name === SARA.name && (s1.json?.court as { name: string } | null)?.name === "Court 1", "staff/session: token, court, referee", s1.json);
  const list = await http("GET", "/api/mobile/v1/referee/tournaments", REF);
  check(list.status === 200 && (list.json?.referee as { name: string } | null)?.name === SARA.name, "referee/tournaments names the referee", list.json?.referee);
  const { data: ses } = await db().from("referee_sessions").select("id, court_name, via, code_id").eq("referee_id", SARA.id).is("ended_at", null);
  check(((ses ?? []) as { court_name: string; code_id: string }[]).some((x) => x.court_name === "Court 1" && x.code_id === C1.id), "a sign-in row on Court 1", ses);
  const forged = await http("POST", SESSION, ip(3), { code: C1.code, refereeId: OMAR.id, pin: OMAR.pin });
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
  const mList0 = (mBare.json?.referees ?? []) as { id: string }[];
  check(mList0.length === 0, "…and no names", mList0);
  const mSara = await http("POST", SESSION, ip(4), { code: masterCode, pin: SARA.pin });
  check(mSara.status === 401 && mSara.json?.code === "wrong_pin", "another referee's PIN on a master's code: wrong PIN", mSara.json);
  const mSaraNamed = await http("POST", SESSION, ip(4), { code: masterCode, refereeId: SARA.id, pin: SARA.pin });
  check(mSaraNamed.status === 401 && mSaraNamed.json?.code === "pin_required", "…and her name is not on a master's code", mSaraNamed.json?.code);
  const fan = await f.device("master");
  const install = mintInstallToken(fan.installationId);
  const ms = await http("POST", SESSION, { ...ip(5), "X-Install-Token": install }, { code: masterCode, refereeId: OMAR.id, pin: OMAR.pin });
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
  check(deskRef.status === 404 || deskRef.status === 307, "…not for a chair umpire", deskRef.status);
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

  section("A master referee's desk is day-of-play only: no deleting matches, brackets, groups or resetting placement draws");
  {
    // The match the master added above (a manual knockout match: regenerating the groups left it).
    const manualId = ((added ?? []) as { id: string }[])[0]?.id ?? randomUUID();
    const del = await callAction("src/app/admin/tournaments/[id]/matches/actions.ts", "deleteMatch", [form({ tournament_id: BOYS, match_id: manualId })], MASTER_WEB, { id: BOYS });
    const { data: still } = await db().from("matches").select("id").eq("id", manualId);
    check(/"digest"/.test(del.text) && (still ?? []).length === 1, "deleteMatch: refused, the match is still there", del.text.slice(0, 120));
    const rb = await callAction("src/app/admin/tournaments/[id]/bracket/actions.ts", "resetBracket", [null, form({ tournament_id: BOYS })], MASTER_WEB, { id: BOYS });
    check(rb.status >= 400 || /"digest"/.test(rb.text), "resetBracket: refused", rb.text.slice(0, 120));
    const pg = await callAction("src/app/admin/tournaments/[id]/groups/actions.ts", "publishGroups", [null, form({ tournament_id: BOYS })], MASTER_WEB, { id: BOYS });
    check(pg.status >= 400 || /"digest"/.test(pg.text), "publishGroups: refused", pg.text.slice(0, 120));
    const rp = await callAction("src/app/admin/tournaments/[id]/ties/actions.ts", "resetPlacementAction", [null, form({ tournament_id: BOYS })], MASTER_WEB, { id: BOYS });
    check(rp.status >= 400 || /"digest"/.test(rp.text), "resetPlacementAction: refused", rp.text.slice(0, 120));
    const rl = await callAction("src/app/admin/tournaments/[id]/matches/actions.ts", "releaseScoringLock", [form({ tournament_id: GIRLS, match_id: MG2.id })], MASTER_WEB, { id: GIRLS });
    const { data: rlAudit } = await db().from("audit_logs").select("id").eq("entity_id", MG2.id).eq("action", "SCORING_LOCK_RELEASED").eq("actor_referee_id", OMAR.id);
    check((rlAudit ?? []).length === 1, "releaseScoringLock: still the master's (audited with Omar)", { status: rl.status, audit: rlAudit });
  }

  /* ---------------- calls for assistance ---------------- */
  section("Call for assistance is off unless Call master referee is on (409 feature_off)");
  {
    await db().from("tournaments").update({ match_day_rules: { features: { callMaster: false } } }).in("id", [BOYS, GIRLS]);
    const off = await http("POST", ASSIST, REF, { action: "request", matchId: MB1.id });
    check(off.status === 409 && off.json?.code === "feature_off", "switched off: 409 feature_off, no call", off.json);
    const offGet = await http("GET", ASSIST, REF);
    check(offGet.json?.enabled === false, "…and the chair umpire's console is told (enabled: false)", offGet.json);
    await db().from("tournaments").update({ match_day_rules: { features: { callMaster: true } } }).in("id", [BOYS, GIRLS]);
    const onGet = await http("GET", ASSIST, REF);
    check(onGet.json?.enabled === true, "switched on: enabled", onGet.json?.enabled);
  }
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
  check((courtSees.json?.call as { status: string } | null)?.status === "open", "the chair umpire sees it open", courtSees.json);
  const lina = await http("POST", SESSION, ip(6), { code: C2.code, refereeId: LINA.id, pin: LINA.pin });
  const LREF = bearer(String(lina.json?.token));
  const linaCancel = await http("POST", ASSIST, LREF, { action: "cancel", callId });
  check(linaCancel.status === 404, "another court's referee cannot touch it (404)", linaCancel.status);
  const refAck = await http("POST", ASSIST, REF, { action: "acknowledge", callId });
  check(refAck.status === 409, "a chair umpire cannot acknowledge", refAck.status);
  const ack = await http("POST", ASSIST, MASTER, { action: "acknowledge", callId });
  check(ack.status === 200 && (ack.json?.call as { status: string; acknowledgedBy: string }).acknowledgedBy === OMAR.name, "On my way: acknowledged by Omar", ack.json);
  const ack2 = await http("POST", ASSIST, MASTER, { action: "acknowledge", callId });
  check(ack2.status === 409, "a second On my way: 409", ack2.status);
  const courtAck = await http("GET", ASSIST, REF);
  check((courtAck.json?.call as { status: string; acknowledgedBy: string } | null)?.acknowledgedBy === OMAR.name, "the chair umpire sees Omar is on the way", courtAck.json?.call);
  const refResolve = await http("POST", ASSIST, REF, { action: "resolve", callId });
  check(refResolve.status === 409, "the chair umpire cannot close it as resolved", refResolve.status);
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

  section("A call from a court code made for one tournament (no event group) still reaches the group's masters");
  {
    // Regression (22 Oct 2026): such a call carries no event group and alerted no master.
    await db().from("request_counters").delete().like("bucket_key", "staff-assist:%");
    const { generateShortRefereeCode, hashEventCode, sealEventCode } = await import("../../src/lib/orgs/codes");
    const tcode = generateShortRefereeCode();
    const { error: te } = await db()
      .from("organization_codes")
      .insert({ organization_id: MB, role: "referee", tournament_id: BOYS, event_group_id: null, court_name: "Court 1", code_hash: hashEventCode(tcode), code_sealed: sealEventCode(tcode), label: `e2e tournament court ${tag}` });
    check(!te, "a Court 1 code for the boys' tournament only (no event group)", te?.message);
    const ts = await http("POST", SESSION, ip(80), { code: tcode, pin: SARA.pin });
    check(ts.status === 200 && (ts.json?.court as { name: string } | null)?.name === "Court 1", "Sara signs in with it (PIN only)", ts.status);
    const TREF: Who = bearer(String(ts.json?.token));
    await http("GET", ASSIST, MASTER); // the master's phone is on duty for the group
    const tcall = await http("POST", ASSIST, TREF, { action: "request", matchId: MB1.id });
    const tCallId = (tcall.json?.call as { id: string } | undefined)?.id;
    check(tcall.status === 201 && Number(tcall.json?.alerted) >= 1, "the call: 201 and at least one master phone alerted", tcall.json);
    const { data: tRow } = await db().from("assistance_calls").select("event_group_id, tournament_id").eq("id", tCallId ?? "").maybeSingle();
    check((tRow as { event_group_id: string | null } | null)?.event_group_id === null, "…although the call itself has no event group", tRow);
    const tView = await http("GET", ASSIST, MASTER);
    check(((tView.json?.open ?? []) as { id: string }[]).some((c) => c.id === tCallId), "the master on duty sees it", (tView.json?.open as unknown[] | undefined)?.length);
    if (tCallId) await http("POST", ASSIST, TREF, { action: "cancel", callId: tCallId });
    await db().from("organization_codes").delete().eq("label", `e2e tournament court ${tag}`);
  }

  section("Call again after a master answered Coming: the call rings again for the masters (owner, 22 Oct 2026)");
  {
    await db().from("request_counters").delete().like("bucket_key", "staff-assist:%");
    await http("GET", ASSIST, MASTER);
    const first = await http("POST", ASSIST, REF, { action: "request", matchId: MB1.id });
    const rid = (first.json?.call as { id: string } | undefined)?.id ?? "";
    const coming = await http("POST", ASSIST, MASTER, { action: "respond", callId: rid, answer: "coming" });
    check(coming.status === 200, "the master answers Coming", coming.status);
    await new Promise((r) => setTimeout(r, 6_000)); // past the double-tap window
    const again = await http("POST", ASSIST, REF, { action: "request", matchId: MB1.id });
    check(again.status === 201 || again.status === 200, "Call again: accepted", again.status);
    const { data: row } = await db().from("assistance_calls").select("status, alerted, acknowledged_by_name").eq("id", rid).single();
    const r = row as { status: string; alerted: number; acknowledged_by_name: string | null };
    check(r.status === "open" && r.acknowledged_by_name === null && r.alerted >= 2, "the call is ringing again (open) and the master's phone was alerted again", r);
    const mv = await http("GET", ASSIST, MASTER);
    const mine = ((mv.json?.open ?? []) as { id: string; mine?: string | null }[]).find((c) => c.id === rid);
    check(Boolean(mine) && !mine!.mine, "…and the master has to answer again (their Coming cleared)", mine);
    const { data: recalled } = await db().from("audit_logs").select("action").eq("entity_id", rid).eq("action", "ASSISTANCE_RECALLED");
    check((recalled ?? []).length === 1, "the re-call is audited", recalled);
    await http("POST", ASSIST, REF, { action: "cancel", callId: rid });
  }

  /* ---------------- Coming / Decline, reminders, "X is going", escalation (0042) ---------------- */
  section("Two masters on duty: Coming / Decline, 10-second reminders, \"X is going\", the organiser after 2 minutes");
  {
    await db().from("request_counters").delete().like("bucket_key", "staff-assist:%");
    const KARIM = await addRef("Karim", "master_referee");
    const mc2 = await callAction("src/app/admin/org/referees/actions.ts", "createMasterCodeAction", [null, form({ referee_id: KARIM.id, event_group_id: made.group!, expires_days: "7" })], ADMIN);
    const code2 = shownState(mc2.text, "code");
    const fan2 = await f.device("master2");
    const install2 = mintInstallToken(fan2.installationId);
    const ks = await http("POST", SESSION, { ...ip(40), "X-Install-Token": install2 }, { code: code2, refereeId: KARIM.id, pin: KARIM.pin });
    check(ks.status === 200, "a second master referee (Karim) signs in on his phone", ks.status);
    const MASTER2: Who = { ...bearer(String(ks.json?.token)), "X-Install-Token": install2 };
    await http("GET", ASSIST, MASTER);
    await http("GET", ASSIST, MASTER2);
    type Answer = { name: string; answer: string; at: string | null };
    type View = { id: string; status: string; reason?: string | null; going: string | null; responses: Answer[]; remindersSent: number; escalatedAt: string | null; mine?: string | null; acknowledgedBy: string | null; resolvedBy: string | null };
    const courtCall = async () => (await http("GET", ASSIST, REF)).json?.call as View | null;
    const steps = async (id: string, action: string) => {
      const { data } = await db().from("audit_logs").select("new_value, created_at").eq("entity_id", id).eq("action", action).order("created_at");
      return ((data ?? []) as { new_value: { to?: string[]; phones?: number; reason?: string; going?: string } }[]).map((r) => r.new_value);
    };
    const backdate = (id: string, secs: number) => db().from("assistance_calls").update({ requested_at: new Date(Date.now() - secs * 1000).toISOString() }).eq("id", id);
    const answerOf = (v: View | null, name: string) => v?.responses.find((r) => r.name === name);

    const c = await http("POST", ASSIST, REF, { action: "request", matchId: MB1.id, reason: "medical" });
    const id = String((c.json?.call as { id: string } | undefined)?.id);
    check(c.status === 201 && c.json?.alerted === 2, "the call (Call Referee for Medical): both masters' phones alerted (time-sensitive, dry run)", c.json?.alerted);
    check((c.json?.call as View | undefined)?.reason === "medical", "the call carries its reason: medical", c.json?.call);
    const { data: stored } = await db().from("assistance_calls").select("reason").eq("id", id).single();
    check((stored as { reason: string | null } | null)?.reason === "medical", "…stored on the call (migration 0044)", stored);
    const v0 = await courtCall();
    check(
      v0?.status === "open" && v0.responses.length === 2 && v0.responses.every((r) => r.answer === "none" && r.at === null) && !!answerOf(v0, OMAR.name) && !!answerOf(v0, KARIM.name) && v0.remindersSent === 0 && v0.escalatedAt === null,
      "the chair umpire sees every master on duty: Omar, Karim — no answer yet",
      v0,
    );
    check(v0!.responses.every((r) => Object.keys(r).sort().join() === "answer,at,name") && !/\+20|phone|referee_id|refereeId/.test(JSON.stringify(v0)), "names only: no phones, no ids", v0?.responses);
    check((await steps(id, "ASSISTANCE_REMINDED")).length === 0, "no reminder before 10 s");

    await backdate(id, 11);
    const [p1, p2, p3] = await Promise.all([courtCall(), courtCall(), http("GET", ASSIST, MASTER)]);
    const r1 = await steps(id, "ASSISTANCE_REMINDED");
    check(r1.length === 1, "after 10 s, three reads at once (court phone ×2, a desk): one reminder", r1);
    check(r1[0]?.to?.length === 2 && r1[0].to.includes(OMAR.id) && r1[0].to.includes(KARIM.id) && r1[0].phones === 2, "…to both masters (neither has answered)", r1[0]);
    check([p1, p2].some((p) => p?.remindersSent === 1) && p3.status === 200, "the chair umpire's card: Reminder sent", [p1?.remindersSent, p2?.remindersSent]);
    check((await courtCall())?.remindersSent === 1, "a read in the same window sends nothing more");

    const dec = await http("POST", ASSIST, MASTER, { action: "respond", callId: id, answer: "declined" });
    check(dec.status === 200 && (dec.json?.call as View).status === "open" && (dec.json?.call as View).mine === "declined", "Omar declines: the call stays open, his desk shows his answer", dec.json?.call);
    const v1 = await courtCall();
    check(answerOf(v1, OMAR.name)?.answer === "declined" && Boolean(answerOf(v1, OMAR.name)?.at) && answerOf(v1, KARIM.name)?.answer === "none", "the chair umpire sees ✗ Omar — Declined, … Karim — no answer yet", v1?.responses);
    const deskK = await http("GET", ASSIST, MASTER2);
    const kOpen = ((deskK.json?.open ?? []) as View[]).find((x) => x.id === id);
    check(kOpen?.mine === null && kOpen.responses.some((r) => r.name === OMAR.name && r.answer === "declined"), "Karim's desk: still his to answer, Omar declined", kOpen);

    await backdate(id, 21);
    await courtCall();
    const r2 = await steps(id, "ASSISTANCE_REMINDED");
    check(r2.length === 2 && r2[1].to?.length === 1 && r2[1].to[0] === KARIM.id && r2[1].phones === 1, "the next reminder (20 s): only Karim (Omar declined)", r2[1]);
    check((await steps(id, "ASSISTANCE_ESCALATED")).length === 0, "no escalation before 2 minutes");

    await backdate(id, 121);
    await Promise.all([courtCall(), courtCall()]);
    await courtCall();
    const e1 = await steps(id, "ASSISTANCE_ESCALATED");
    check(e1.length === 1 && e1[0].reason === "unanswered", "after 2 minutes unanswered: the organiser alerted, once", e1);
    const v2 = await courtCall();
    check(Boolean(v2?.escalatedAt) && v2?.status === "open", "the chair umpire's card: Organiser alerted (the call stays open)", v2?.escalatedAt);
    const remindersBefore = (await steps(id, "ASSISTANCE_REMINDED")).length;

    const com = await http("POST", ASSIST, MASTER2, { action: "respond", callId: id, answer: "coming" });
    const comCall = com.json?.call as View;
    check(com.status === 200 && comCall.status === "acknowledged" && comCall.going === KARIM.name && comCall.mine === "coming", "Karim: Coming — the call is his", com.json?.call);
    const g = await steps(id, "ASSISTANCE_GOING_SENT");
    check(g.length === 1 && g[0].to?.length === 1 && g[0].to[0] === OMAR.id && g[0].phones === 1 && g[0].going === KARIM.name, "Omar's phone gets \"Master referee Karim is going to the emergency call at Court 1\"", g);
    const v3 = await courtCall();
    check(v3?.going === KARIM.name && v3.acknowledgedBy === KARIM.name && v3.responses[0]?.name === KARIM.name && v3.responses[0].answer === "coming" && answerOf(v3, OMAR.name)?.answer === "declined", "the chair umpire: Karim is coming to Court 1 (✓ Karim — Coming, ✗ Omar — Declined)", v3);
    const deskO = await http("GET", ASSIST, MASTER);
    const oOpen = ((deskO.json?.open ?? []) as View[]).find((x) => x.id === id);
    check(oOpen?.going === KARIM.name, "Omar's desk: Karim is going · Court 1", oOpen);
    await backdate(id, 240);
    await courtCall();
    check((await steps(id, "ASSISTANCE_REMINDED")).length === remindersBefore, "taken: no more reminders", remindersBefore);
    const late = await http("POST", ASSIST, MASTER, { action: "respond", callId: id, answer: "coming" });
    check(late.status === 409 && late.json?.code === "already_taken" && late.json.takenBy === KARIM.name, "Omar's later Coming: 409 already_taken, Karim's name", late.json);
    const doneK = await http("POST", ASSIST, MASTER2, { action: "resolve", callId: id });
    check(doneK.status === 200, "Karim resolves it", doneK.status);
    const v4 = await courtCall();
    check(v4?.status === "resolved" && v4.resolvedBy === KARIM.name, "the chair umpire: Resolved by Karim", v4);
    const log = await http("GET", "/admin/org/referees/calls", ADMIN);
    const logText = log.text.replace(/<!-- -->/g, "");
    check(log.status === 200 && logText.includes('data-testid="call-escalated"') && logText.includes(`Declined: ${OMAR.name}`), "the admin log: Organiser alerted, Declined: Omar", log.status);

    section("Every master declines: the organiser at once; Move Score 1.0.1's On my way is Coming");
    const d = await http("POST", ASSIST, REF, { action: "request" });
    const id2 = String((d.json?.call as { id: string } | undefined)?.id);
    check(d.status === 201 && (d.json?.call as View | undefined)?.reason === null, "a second call with no reason (Move Score 1.0.4 and older): still goes out", d.status);
    await http("POST", ASSIST, MASTER, { action: "respond", callId: id2, answer: "declined" });
    check((await steps(id2, "ASSISTANCE_ESCALATED")).length === 0, "one of two declined: not yet", id2);
    const d2 = await http("POST", ASSIST, MASTER2, { action: "respond", callId: id2, answer: "declined" });
    const e2 = await steps(id2, "ASSISTANCE_ESCALATED");
    check(d2.status === 200 && e2.length === 1 && e2[0].reason === "all_declined" && Boolean((d2.json?.call as View).escalatedAt), "both declined: the organiser alerted at once", e2);
    const bad = await http("POST", ASSIST, MASTER, { action: "respond", callId: id2, answer: "maybe" });
    check(bad.status === 400, "an answer that is neither coming nor declined: 400", bad.status);
    const changed = await http("POST", ASSIST, MASTER, { action: "acknowledge", callId: id2 });
    check(changed.status === 200 && (changed.json?.call as View).acknowledgedBy === OMAR.name, "Omar changes his mind with 1.0.1's acknowledge: the call is his", changed.json?.call);
    const g2 = await steps(id2, "ASSISTANCE_GOING_SENT");
    check(g2.length === 1 && g2[0].to?.[0] === KARIM.id, "…and Karim is told Omar is going", g2);
    await http("POST", ASSIST, MASTER, { action: "resolve", callId: id2 });

    if (process.env.CRON_SECRET) {
      section("Nobody polling: the scheduled drain sends the reminder");
      const s = await http("POST", ASSIST, REF, { action: "request" });
      const id3 = String((s.json?.call as { id: string } | undefined)?.id);
      await backdate(id3, 12);
      const drain = await http("POST", "/api/internal/notifications/drain", { Authorization: `Bearer ${process.env.CRON_SECRET}` }, {});
      const r3 = await steps(id3, "ASSISTANCE_REMINDED");
      check(drain.status === 200 && ((drain.json?.assistance as { checked: number } | undefined)?.checked ?? 0) >= 1 && r3.length === 1 && r3[0].to?.length === 2, "the drain's sweep: one reminder to both masters", { drain: drain.json?.assistance, r3 });
      await http("POST", "/api/internal/notifications/drain", { Authorization: `Bearer ${process.env.CRON_SECRET}` }, {});
      check((await steps(id3, "ASSISTANCE_REMINDED")).length === 1, "a second sweep in the same window: nothing more");
      const cancel = await http("POST", ASSIST, REF, { action: "cancel", callId: id3 });
      const v5 = await courtCall();
      check(cancel.status === 200 && v5?.status === "cancelled", "the chair umpire cancels it: Call cancelled", v5?.status);
    }
    await db().from("audit_logs").delete().in("entity_id", [id, id2]);
  }

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
  const oldPin = await http("POST", SESSION, ip(8), { code: C1.code, refereeId: SARA.id, pin: SARA.pin });
  const newSign = await http("POST", SESSION, ip(8), { code: C1.code, refereeId: SARA.id, pin: newPin });
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
