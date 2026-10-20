/**
 * The user-guide demo event, for real app screenshots on the local stand-in:
 * "Junior Team Finals — Guide demo" (slug junior-finals-guide), Move Beyond's,
 * Smash Sporting Club, today to today + 6 days.
 *
 *   - Eight nations (EGY, USA, FRA, ESP in Group A; JPN, CZE, CAN, ROU in Group B), four
 *     fictional players each, the group ties drawn by the app (S2, S1, D per tie).
 *   - Today's round 1 on Court 1, Court 2, Court 13 and Court 14 with not-before times:
 *     Court 2's tie finished (every rubber played point by point through the events API,
 *     aces and double faults included, so the Stats card has data), Court 1's tie live
 *     (No. 2 singles won, No. 1 singles in its second set), Court 13 next with line-ups
 *     locked, Court 14 later with line-ups still to come. Rounds 2 and 3 on the next days.
 *   - Match-day rules on (tennis defaults), the sample 3D venue map published, event info
 *     published (generic placeholder content), play status normal.
 *   - Referee "Ahmed Referee" (PIN 2468) with court codes for the four courts, master
 *     referee "Sara Master" (PIN 1357) with a master code, the coach code of Egypt, and a
 *     player code for one of Egypt's players. Everything is printed at the end.
 *
 * Stand-in only (refuses any non-local SUPABASE_URL). Needs the production build running
 * on BASE_URL (http://localhost:3077 in .env.localdb) with PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1:
 *
 *   npx tsx --env-file=.env.localdb scripts/demo/guide-demo.ts          # (re)creates it
 *   npx tsx --env-file=.env.localdb scripts/demo/guide-demo.ts remove   # removes it
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import * as C from "../../src/lib/scoring/console";
import type { ScoreState, TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { ensureMainScreen } from "../../src/lib/screens";
import { getMatches, getTournament } from "../../src/lib/data";
import { generateGroupTies, getTies, lockLineups, scheduleTie, setLineup } from "../../src/lib/tennis/tieOps";
import { nationByCode } from "../../src/lib/tennis/nations";
import { zonedToIso } from "../../src/lib/tennis/ties";
import { newTournamentMatchDayRules } from "../../src/lib/matchday/rules";
import { eventDay } from "../../src/lib/matchday/eventDay";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { formatEventCode, generateEventCode, hashEventCode, openEventCode, sealEventCode } from "../../src/lib/orgs/codes";
import { courtCodeLabel, courtLink } from "../../src/lib/orgs/courtScope";
import { coachLink } from "../../src/lib/coaches/rules";
import { hashRefereePin } from "../../src/lib/referees/pin";
import { issuePlayerCode } from "../../src/lib/players/codeVault";
import { formatAccessCode } from "../../src/lib/players/accessCode";
import { saveVenueDoc, venueOwnerOf } from "../../src/lib/venue/server";
import { sampleVenue } from "../../src/lib/venue/sample";
import { eventInfoOwnerOf, saveEventInfo } from "../../src/lib/eventInfo/server";
import { cleanEventInfo } from "../../src/lib/eventInfo/clean";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Match, type Tie, type Tournament } from "../../src/lib/types";
import { sessionToken } from "../e2e/lib/session";

const SLUG = "junior-finals-guide";
const NAME = "Junior Team Finals — Guide demo";
const TZ = "Africa/Cairo";
const SITE = "https://tour.mbeg.org";
const BASE = process.env.BASE_URL ?? "http://localhost:3077";
const REFEREE = { name: "Ahmed Referee", pin: "2468" };
const MASTER = { name: "Sara Master", pin: "1357" };
const COURTS = ["Court 1", "Court 2", "Court 13", "Court 14"];

/** Fictional squads, in order of merit. */
const NATIONS: [string, string[]][] = [
  ["EGY", ["Omar Khaled", "Youssef Nabil", "Karim Fathy", "Adam Samir"]],
  ["USA", ["Jack Morgan", "Ryan Cole", "Tyler Brooks", "Evan Price"]],
  ["FRA", ["Hugo Laurent", "Louis Moreau", "Jules Petit", "Theo Garnier"]],
  ["ESP", ["Pablo Serrano", "Diego Navarro", "Alvaro Ortega", "Mateo Vidal"]],
  ["JPN", ["Riku Ishida", "Kaito Mori", "Ren Fujita", "Yuto Okada"]],
  ["CZE", ["Tomas Horak", "Jakub Vesely", "Matej Cerny", "Ondrej Pokorny"]],
  ["CAN", ["Liam Tremblay", "Noah Gagnon", "Ethan Roy", "Owen Bouchard"]],
  ["ROU", ["Andrei Munteanu", "Stefan Radu", "Vlad Dobre", "Mihai Stoica"]],
];
const GROUP_A = ["EGY", "USA", "FRA", "ESP"];

function standIn() {
  const url = process.env.SUPABASE_URL ?? "";
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) throw new Error("guide-demo runs against the local stand-in only (SUPABASE_URL must be localhost)");
  if (!process.env.STAFF_SESSION_SECRET || !process.env.EVENT_CODE_PEPPER || !process.env.PLAYER_CODE_PEPPER) throw new Error("run with --env-file=.env.localdb");
}

const ADMIN = { Cookie: `mb_session=${sessionToken("admin")}` };
async function http(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...ADMIN, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text };
}

async function moveBeyond(): Promise<string> {
  const { data } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  if (!data) throw new Error("no Move Beyond organisation on the stand-in");
  return (data as { id: string }).id;
}

/* ---------------- remove ---------------- */
async function remove(MB: string) {
  const { data: t } = await db().from("tournaments").select("id").eq("slug", SLUG).maybeSingle();
  const tid = (t as { id: string } | null)?.id;
  const { data: refs } = await db().from("referees").select("id").eq("organization_id", MB).in("name", [REFEREE.name, MASTER.name]);
  const refIds = ((refs ?? []) as { id: string }[]).map((r) => r.id);
  if (refIds.length) {
    await db().from("organization_codes").delete().in("referee_id", refIds);
    await db().from("assistance_calls").delete().in("referee_id", refIds);
    await db().from("audit_logs").delete().in("actor_referee_id", refIds);
    await db().from("referee_sessions").delete().in("referee_id", refIds);
    await db().from("referees").delete().in("id", refIds);
  }
  if (!tid) return Boolean(refIds.length);
  const { data: pl } = await db().from("players").select("id").eq("tournament_id", tid);
  const playerIds = ((pl ?? []) as { id: string }[]).map((p) => p.id);
  if (playerIds.length) await db().from("player_claims").delete().in("player_id", playerIds);
  await db().from("organization_codes").delete().eq("tournament_id", tid);
  for (const table of ["coach_sessions", "coach_codes", "venue_maps", "assistance_calls", "match_calls", "audit_logs", "follows", "notification_events"]) {
    const { error } = await db().from(table).delete().eq("tournament_id", tid);
    if (error && !/column|does not exist|relation/i.test(error.message)) console.warn(`${table}: ${error.message}`);
  }
  const { error } = await db().from("tournaments").delete().eq("id", tid);
  if (error) throw new Error(`tournaments: ${error.message}`);
  return true;
}

/* ---------------- scoring through the events API ---------------- */
let seed = 20261020;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** A referee console that sends its steps to the events API in batches, with made-up but plausible device times. */
class Scorer {
  state: ScoreState | null = null;
  n = 0;
  queue: Record<string, unknown>[] = [];
  clock: number;
  readonly device = `guide-demo-${randomUUID().slice(0, 8)}`;
  constructor(
    private m: Match,
    readonly opts: C.ConsoleOptions,
    startAt: number,
  ) {
    this.clock = startAt;
  }
  ids = (k: TeamKey) => (k === "A" ? this.m.team_a_id! : this.m.team_b_id!);
  async claim() {
    const r = await http("POST", `/api/matches/${this.m.id}/claim`, { deviceId: this.device, deviceLabel: "Guide demo" });
    if (r.status !== 200) throw new Error(`claim ${this.m.round_name}: ${r.status} ${r.text}`);
  }
  step(e: C.ConsoleEvent | null, seconds: number) {
    if (!e) throw new Error("the console refused a step");
    this.n++;
    this.clock += seconds * 1000;
    this.queue.push({
      client_event_id: randomUUID(),
      event_number: this.n,
      event_type: e.eventType,
      team_id: e.team ? this.ids(e.team) : null,
      previous_state: this.state,
      new_state: e.next,
      payload: e.winner ? { ...(e.payload ?? {}), winner_team_id: this.ids(e.winner) } : e.payload,
      created_at_client: new Date(this.clock).toISOString(),
    });
    this.state = e.next;
  }
  async flush() {
    while (this.queue.length) {
      const batch = this.queue.splice(0, 25);
      const r = await http("POST", `/api/matches/${this.m.id}/events`, { deviceId: this.device, events: batch });
      if (r.status !== 200) throw new Error(`events ${this.m.round_name}: ${r.status} ${r.text.slice(0, 400)}`);
    }
  }
  /** One point: sometimes an ace, a double fault or a first-serve fault, else a rally won by `fav` with probability `p`. */
  point(fav: TeamKey, p: number) {
    const s = this.state!;
    const server = s.servingTeam ?? "A";
    const r = rand();
    if (!s.isTiebreak && r < 0.07) return this.step(C.aceEvent(s, this.opts), 25);
    if (r < 0.32) {
      this.step(C.faultEvent(s, this.opts), 15);
      if (rand() < 0.13) return this.step(C.faultEvent(this.state!, this.opts), 25); // double fault
    }
    const winner: TeamKey = rand() < (server === fav ? p + 0.08 : p - 0.08) ? fav : fav === "A" ? "B" : "A";
    this.step(C.point(this.state!, winner, this.opts), 40);
  }
}

async function playRubber(t: Tournament, m: Match, fav: TeamKey, startAt: number, stop?: (s: ScoreState) => boolean) {
  const opts: C.ConsoleOptions = { config: scoringConfigForMatch(t, m, null, { doubles: m.rubber_type === "D" }), confirmFirst: t.scoring_config?.requireResultConfirmation === true, online: true, tennis: true, doubles: m.rubber_type === "D" };
  const sc = new Scorer(m, opts, startAt);
  await sc.claim();
  sc.step(C.startMatch(rand() < 0.5 ? "A" : "B"), 0);
  let guard = 0;
  while (!sc.state!.matchOver && !(stop && stop(sc.state!))) {
    sc.point(fav, 0.6);
    if (++guard > 3000) throw new Error("runaway rubber");
  }
  if (sc.state!.matchOver && opts.confirmFirst) sc.step(C.confirmResult(sc.state!, opts), 20);
  await sc.flush();
  if (!sc.state!.matchOver) await http("POST", `/api/matches/${m.id}/release-lease`, { deviceId: sc.device });
  return sc;
}

/* ---------------- event info (generic placeholders, no invented facts) ---------------- */
function eventInfo(days: string[]) {
  return cleanEventInfo({
    intro: "Welcome to the Junior Team Finals guide demo. Everything on this page is sample content.",
    entry: {
      admission: "free",
      ticketsNote: "Entry is free for this demo event. No ticket needed.",
      ticketsUrl: "",
      allowed: ["Water bottles", "Small bags", "Hats and sun cream"],
      notAllowed: ["Glass bottles", "Drones", "Flash photography during points"],
      kids: "Children are welcome with an adult.",
      photography: "Photos without flash between points. Please stay seated while a point is played.",
      other: "Sample text: replace with the venue's own rules.",
    },
    hours: days.map((date) => ({ date, opens: "09:00", closes: "21:00", note: "", closed: false })),
    directions: {
      address: "Smash Sporting Club, Cairo (sample address)",
      landmark: "Sample landmark: replace with the real one",
      dropOff: "Main Entrance drop-off (sample)",
      transit: "Sample text: taxi and ride-hailing to the Main Entrance.",
      lat: 30.1008,
      lng: 31.3708,
      googleMapsUrl: "",
      appleMapsUrl: "",
    },
    parking: "Car park next to the Main Entrance (sample text).",
    food: "Clubhouse café & buffet open during play (sample text).",
    contacts: [{ label: "Tournament desk", phone: "+201000000000", whatsapp: true, email: "info@mbeg.org" }],
    faqs: [
      { q: "Is entry free?", a: "Yes, for this demo event." },
      { q: "Where can I see the order of play?", a: "In the Move Score app under Schedule, and on the screens at the venue." },
      { q: "Can I follow a nation?", a: "Yes: open the nation and tap Follow to get match alerts." },
    ],
  });
}

/* ---------------- create ---------------- */
async function create(MB: string) {
  const today = eventDay(TZ);
  const dayOf = (offset: number) => eventDay(TZ, Date.parse(`${today}T12:00:00Z`) + offset * 86_400_000);
  const days = Array.from({ length: 7 }, (_, i) => dayOf(i));
  const ends = days[6];
  const now = Date.now();
  const quarter = (ms: number) => new Date(Math.round(ms / 900_000) * 900_000).toISOString();

  const { data: tr, error } = await db()
    .from("tournaments")
    .insert({
      name: NAME,
      slug: SLUG,
      sport: "tennis",
      kind: "tournament",
      status: "active",
      is_demo: false,
      public_access_enabled: true,
      organization_id: MB,
      created_by: "admin",
      timezone: TZ,
      starts_on: today,
      ends_on: ends,
      venue_name: "Smash Sporting Club",
      city: "Cairo",
      scoring_config: DEFAULT_TENNIS_SCORING_CONFIG,
      format_config: { type: "group_knockout", qualifyPerGroup: 2, thirdPlaceMatch: false, ties: { rubbers: ["S2", "S1", "D"] } },
      match_day_rules: newTournamentMatchDayRules("tennis"),
      lower_third_text: "Guide demo · sample event · Smash Sporting Club, Cairo",
    })
    .select("id")
    .single();
  if (error) throw new Error(`tournament: ${error.message}`);
  const tid = (tr as { id: string }).id;
  await ensureMainScreen(tid);
  const { data: cs } = await db().from("courts").insert(COURTS.map((court_name, i) => ({ tournament_id: tid, court_name, court_order: i + 1 }))).select("id, court_name");
  const court = new Map(((cs ?? []) as { id: string; court_name: string }[]).map((c) => [c.court_name, c.id]));

  // Nations and squads
  const teamOf = new Map<string, { id: string; players: string[] }>();
  for (const [i, [code, names]] of NATIONS.entries()) {
    const n = nationByCode(code)!;
    const { data: team, error: te } = await db()
      .from("teams")
      .insert({ tournament_id: tid, team_name: n.name, nation_code: code, iso2: n.iso2, captain_name: `Captain of ${n.name}`, seed_number: i + 1, check_in_status: "checked_in", team_status: "active" })
      .select("id")
      .single();
    if (te) throw new Error(`teams: ${te.message}`);
    const { data: ps } = await db()
      .from("players")
      .insert(names.map((full_name, j) => ({ tournament_id: tid, team_id: (team as { id: string }).id, player_order: j + 1, full_name })))
      .select("id, player_order");
    teamOf.set(code, { id: (team as { id: string }).id, players: ((ps ?? []) as { id: string; player_order: number }[]).sort((a, b) => a.player_order - b.player_order).map((p) => p.id) });
  }
  const codeOfTeam = new Map([...teamOf].map(([c, t]) => [t.id, c]));

  // Groups and the app's own draw (makes the coach codes too)
  const { data: gs } = await db()
    .from("groups")
    .insert(["Group A", "Group B"].map((group_name, i) => ({ tournament_id: tid, group_name, group_order: i + 1, status: "published" })))
    .select("id, group_name");
  const gid = new Map(((gs ?? []) as { id: string; group_name: string }[]).map((g) => [g.group_name, g.id]));
  await db().from("group_teams").insert(
    NATIONS.map(([code], i) => ({ tournament_id: tid, group_id: gid.get(GROUP_A.includes(code) ? "Group A" : "Group B")!, team_id: teamOf.get(code)!.id, position: (i % 4) + 1 })),
  );
  await generateGroupTies(tid, "admin");
  const ties = await getTies(tid);
  const round = (r: number, g: string) => ties.filter((x) => x.round_no === r && x.group_id === gid.get(g));
  const label = (x: Tie) => `${codeOfTeam.get(x.team_a_id!)} v ${codeOfTeam.get(x.team_b_id!)}`;

  // Today's round 1: the tie with Egypt live on Court 1, the other Group A tie finished on Court 2.
  const [a1, a2] = round(1, "Group A");
  const live = [a1, a2].find((x) => [x.team_a_id, x.team_b_id].includes(teamOf.get("EGY")!.id))!;
  const done = live === a1 ? a2 : a1;
  const [next, later] = round(1, "Group B");
  const plan: [Tie, string, string][] = [
    [done, "Court 2", quarter(now - 4 * 3600_000)],
    [live, "Court 1", quarter(now - 75 * 60_000)],
    [next, "Court 13", quarter(now + 60 * 60_000)],
    [later, "Court 14", quarter(now + 150 * 60_000)],
  ];
  // Rounds 2 and 3 on the next two days, 10:00 and 14:00 Cairo time.
  for (const r of [2, 3]) {
    const day = dayOf(r - 1);
    const list = [...round(r, "Group A"), ...round(r, "Group B")];
    list.forEach((x, i) => plan.push([x, COURTS[i % 4], zonedToIso(`${day}T${i < 4 ? "10:00" : "14:00"}`, TZ)!]));
  }
  for (const [x, c, at] of plan) {
    const r = await scheduleTie(tid, x.id, court.get(c)!, at, "admin");
    if (!r.ok) throw new Error(`schedule ${label(x)}: ${r.message}`);
  }

  // Line-ups: named and locked for the first three of today's ties; Court 14's still to come.
  for (const x of [done, live, next]) {
    for (const side of ["A", "B"] as const) {
      const s = teamOf.get(codeOfTeam.get((side === "A" ? x.team_a_id : x.team_b_id)!)!)!.players;
      const r = await setLineup(tid, x.id, side, { S1: s[0], S2: s[1], D: [s[2], s[3]] }, "admin");
      if (!r.ok) throw new Error(`line-up ${label(x)} ${side}: ${r.message}`);
    }
    const l = await lockLineups(tid, x.id, "admin");
    if (!l.ok) throw new Error(`lock ${label(x)}: ${l.message}`);
  }

  // Play: Court 2's tie in full, Court 1's No. 2 singles and half of its No. 1 singles.
  const t = (await getTournament(tid))!;
  const rubbers = async (x: Tie) => (await getMatches(tid)).filter((m) => m.tie_id === x.id).sort((p, q) => (p.rubber_no ?? 0) - (q.rubber_no ?? 0));
  let at = Date.parse(plan[0][2]);
  for (const [i, m] of (await rubbers(done)).entries()) {
    const sc = await playRubber(t, m, i === 1 ? "B" : "A", at);
    at = sc.clock + 20 * 60_000;
  }
  const egyA = live.team_a_id === teamOf.get("EGY")!.id;
  const [ls2, ls1] = await rubbers(live);
  const s2 = await playRubber(t, ls2, egyA ? "A" : "B", Date.parse(plan[1][2]));
  await playRubber(t, ls1, egyA ? "B" : "A", s2.clock + 15 * 60_000, (s) => s.completedSets.length === 1 && s.teamA.games + s.teamB.games >= 3 && !s.isTiebreak && s.teamA.points !== "0" && s.teamB.points !== "0");

  // Venue map (sample layout) and event info, published
  const vo = await venueOwnerOf(tid);
  await saveVenueDoc(vo!, sampleVenue(), true, "guide-demo");
  const io = await eventInfoOwnerOf(tid);
  const info = eventInfo(days);
  if (info.problems.length) throw new Error(`event info: ${info.problems.join(" ")}`);
  const saved = await saveEventInfo(io!, info.content, true, "");
  if (!saved.ok) throw new Error(`event info: ${saved.reason}`);

  // Referees, court codes, master code
  const expiresAt = zonedToIso(`${ends}T23:59`, TZ);
  const { data: refs, error: re } = await db()
    .from("referees")
    .insert([
      { organization_id: MB, name: REFEREE.name, role: "referee", pin_hash: hashRefereePin(MB, REFEREE.pin) },
      { organization_id: MB, name: MASTER.name, role: "master_referee", pin_hash: hashRefereePin(MB, MASTER.pin) },
    ])
    .select("id, name");
  if (re) throw new Error(`referees: ${re.message} (another active referee of Move Beyond may hold PIN ${REFEREE.pin} or ${MASTER.pin})`);
  const masterId = ((refs ?? []) as { id: string; name: string }[]).find((r) => r.name === MASTER.name)!.id;
  const courtCodes: [string, string][] = [];
  for (const c of COURTS) {
    const code = generateEventCode();
    const { error: ce } = await db().from("organization_codes").insert({ organization_id: MB, role: "referee", tournament_id: tid, court_name: c, code_hash: hashEventCode(code), code_sealed: sealEventCode(code), label: courtCodeLabel(c), expires_at: expiresAt, created_by_role: "admin" });
    if (ce) throw new Error(`court code: ${ce.message}`);
    courtCodes.push([c, formatEventCode(code)]);
  }
  const mcode = generateEventCode();
  const { error: me } = await db().from("organization_codes").insert({ organization_id: MB, role: "master_referee", referee_id: masterId, code_hash: hashEventCode(mcode), label: `${MASTER.name} (master referee)`, expires_at: expiresAt, created_by_role: "admin" });
  if (me) throw new Error(`master code: ${me.message}`);

  // Egypt's coach code (made by the draw) and a player code for Egypt's No. 1
  const { data: cc } = await db().from("coach_codes").select("code_sealed").eq("team_id", teamOf.get("EGY")!.id).is("revoked_at", null).single();
  const coach = formatEventCode(openEventCode((cc as { code_sealed: string }).code_sealed)!);
  const playerCode = formatAccessCode(await issuePlayerCode(teamOf.get("EGY")!.players[0]));

  // Check the public feeds answer
  await new Promise((r) => setTimeout(r, 2500));
  const bundle = await http("GET", `/api/mobile/v1/t/${SLUG}/bundle`);
  const liveFeed = await http("GET", `/api/mobile/v1/t/${SLUG}/live`);

  const out = [
    "",
    `✅ ${NAME} — ${BASE}/t/${SLUG}  (tournament ${tid})`,
    `   today ${today}: ${label(done)} finished on Court 2 · ${label(live)} live on Court 1 · ${label(next)} next on Court 13 · ${label(later)} later on Court 14`,
    `   public bundle ${bundle.status} · live ${liveFeed.status}`,
    "",
    "Referee",
    `   ${REFEREE.name}  PIN ${REFEREE.pin}`,
    ...courtCodes.map(([c, code]) => `   ${c.padEnd(9)} code ${code}   QR ${courtLink(SITE, code)}   app movescore://r#${code}`),
    `   Master referee ${MASTER.name}  PIN ${MASTER.pin}  master code ${formatEventCode(mcode)} (sign in: Referee → code, then the PIN)`,
    "Coach (Egypt)",
    `   code ${coach}   QR ${coachLink(SITE, coach)}   app movescore://c#${coach}`,
    "Player (Egypt No. 1, Omar Khaled)",
    `   player code ${playerCode}  (app: Account → Sign in with a player code)`,
    "Admin web",
    `   ${BASE}/login with ADMIN_PASSWORD from .env.localdb, or set the cookie for localhost: mb_session=${sessionToken("admin")}`,
    "",
  ];
  console.log(out.join("\n"));
}

async function main() {
  standIn();
  const MB = await moveBeyond();
  const removed = await remove(MB);
  if (process.argv[2] === "remove") {
    console.log(removed ? `removed ${SLUG}` : `nothing to remove (${SLUG})`);
    return;
  }
  await create(MB);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
