/**
 * The chair-umpire practice event, shared with the real chair umpires before the Junior Finals:
 * "Junior Team Finals — Umpire Demo" (event group), with two tournaments laid out like the real ones:
 *
 *   - "Davis Cup Junior Finals — Umpire Demo" (slug dc-umpire-demo): Courts 7–13 and 15.
 *   - "BJK Cup Junior Finals — Umpire Demo" (slug bjk-umpire-demo): Courts 1–6, 14 and 16.
 *   - 16 fictional nations per tournament (four players each), four groups, the app's own draw;
 *     today's round 1 has one tie on every court (S2, S1, D), line-ups named and locked, so an
 *     umpire can start the singles straight away. Rounds 2 and 3 tomorrow and the day after.
 *   - 20 chair umpires ("Chair Umpire 01" … "Chair Umpire 20") and one master referee
 *     ("Demo Master Referee"), each with their own 4-digit PIN, all on this event only.
 *   - 16 short court codes (one per court) and the master referee's code, valid for 14 days.
 *
 * The codes and PINs are written to OUT (a JSON file, keep it outside the repo: it is the only
 * place they exist in clear) and drive the umpire guide PDF. Nothing is scored.
 *
 *   npx tsx --env-file=.env.localdb scripts/demo/umpire-demo.ts                 # stand-in
 *   OUT=~/Downloads/umpire-demo-codes.json UMPIRE_DEMO_LIVE=yes \
 *     npx tsx --env-file=<production env> scripts/demo/umpire-demo.ts           # live project
 *   … scripts/demo/umpire-demo.ts remove                                         # removes it
 *
 * Run again = removed and made again (new codes and PINs).
 */
import { writeFileSync } from "fs";
import { db } from "../../src/lib/supabase";
import { generateGroupTies, getTies, lockLineups, scheduleTie, setLineup } from "../../src/lib/tennis/tieOps";
import { nationByCode } from "../../src/lib/tennis/nations";
import { zonedToIso } from "../../src/lib/tennis/ties";
import { newTournamentMatchDayRules } from "../../src/lib/matchday/rules";
import { eventDay } from "../../src/lib/matchday/eventDay";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { formatEventCode, generateShortRefereeCode, hashEventCode, sealEventCode } from "../../src/lib/orgs/codes";
import { freshShortRefereeCode } from "../../src/lib/orgs/freshShortCode";
import { courtCodeLabel, courtLink } from "../../src/lib/orgs/courtScope";
import { hashRefereePin } from "../../src/lib/referees/pin";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Tie } from "../../src/lib/types";

const GROUP = { slug: "junior-finals-umpire-demo", name: "Junior Team Finals — Umpire Demo" };
const SITE = "https://tour.mbeg.org";
const TZ = "Africa/Cairo";
const EVENTS = [
  { slug: "dc-umpire-demo", name: "Davis Cup Junior Finals — Umpire Demo", short: "Davis Cup", boys: true, courts: [7, 8, 9, 10, 11, 12, 13, 15] },
  { slug: "bjk-umpire-demo", name: "BJK Cup Junior Finals — Umpire Demo", short: "BJK Cup", boys: false, courts: [1, 2, 3, 4, 5, 6, 14, 16] },
] as const;
const UMPIRES = Array.from({ length: 20 }, (_, i) => `Chair Umpire ${String(i + 1).padStart(2, "0")}`);
const MASTER = "Demo Master Referee";

/** Fictional squads: [nation, surnames, boys' first names, girls' first names]. */
const SQUADS: [string, string[], string[], string[]][] = [
  ["EGY", ["Khaled", "Nabil", "Fathy", "Samir"], ["Omar", "Youssef", "Karim", "Adam"], ["Nour", "Salma", "Farida", "Malak"]],
  ["USA", ["Morgan", "Cole", "Brooks", "Price"], ["Jack", "Ryan", "Tyler", "Evan"], ["Emma", "Ava", "Grace", "Chloe"]],
  ["FRA", ["Laurent", "Moreau", "Petit", "Garnier"], ["Hugo", "Louis", "Jules", "Theo"], ["Lea", "Manon", "Camille", "Ines"]],
  ["ESP", ["Serrano", "Navarro", "Ortega", "Vidal"], ["Pablo", "Diego", "Alvaro", "Mateo"], ["Lucia", "Paula", "Carla", "Marta"]],
  ["JPN", ["Ishida", "Mori", "Fujita", "Okada"], ["Riku", "Kaito", "Ren", "Yuto"], ["Yui", "Hana", "Aoi", "Mei"]],
  ["CZE", ["Horak", "Vesely", "Cerny", "Pokorny"], ["Tomas", "Jakub", "Matej", "Ondrej"], ["Tereza", "Eliska", "Anna", "Klara"]],
  ["CAN", ["Tremblay", "Gagnon", "Roy", "Bouchard"], ["Liam", "Noah", "Ethan", "Owen"], ["Olivia", "Maya", "Leah", "Zoe"]],
  ["ROU", ["Munteanu", "Radu", "Dobre", "Stoica"], ["Andrei", "Stefan", "Vlad", "Mihai"], ["Ioana", "Elena", "Bianca", "Maria"]],
  ["ITA", ["Rossi", "Bianchi", "Greco", "Conti"], ["Luca", "Matteo", "Marco", "Andrea"], ["Giulia", "Sofia", "Chiara", "Sara"]],
  ["GER", ["Becker", "Wagner", "Schulz", "Hoffmann"], ["Leon", "Felix", "Paul", "Jonas"], ["Lena", "Mia", "Hannah", "Lina"]],
  ["AUS", ["Walker", "Harris", "Kelly", "Ward"], ["Jack", "Oliver", "Lachlan", "Cooper"], ["Ruby", "Isla", "Matilda", "Ella"]],
  ["ARG", ["Fernandez", "Romero", "Acosta", "Sosa"], ["Santiago", "Tomas", "Joaquin", "Facundo"], ["Martina", "Valentina", "Camila", "Julieta"]],
  ["BRA", ["Silva", "Costa", "Almeida", "Rocha"], ["Gabriel", "Lucas", "Rafael", "Pedro"], ["Beatriz", "Larissa", "Luana", "Isabela"]],
  ["GBR", ["Taylor", "Evans", "Hughes", "Wright"], ["Harry", "George", "Alfie", "Oscar"], ["Amelia", "Lily", "Freya", "Poppy"]],
  ["NED", ["de Vries", "Jansen", "Bakker", "Visser"], ["Daan", "Sem", "Lars", "Thijs"], ["Fleur", "Julia", "Sanne", "Noor"]],
  ["SUI", ["Keller", "Meier", "Frei", "Brunner"], ["Noah", "Luca", "Elias", "Nico"], ["Lara", "Nina", "Alina", "Jana"]],
];

function target() {
  const url = process.env.SUPABASE_URL ?? "";
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
  if (!local && process.env.UMPIRE_DEMO_LIVE !== "yes") throw new Error("not the local stand-in: set UMPIRE_DEMO_LIVE=yes to write this demo to the live project");
  if (!process.env.EVENT_CODE_PEPPER) throw new Error("EVENT_CODE_PEPPER is required (court codes and PINs are hashed with it)");
  return local ? "stand-in" : "LIVE";
}

async function moveBeyond(): Promise<string> {
  const { data } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  if (!data) throw new Error("no Move Beyond organisation");
  return (data as { id: string }).id;
}

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data as T;
}

/* ---------------- remove ---------------- */
async function remove(MB: string): Promise<boolean> {
  const { data: g } = await db().from("event_groups").select("id").eq("slug", GROUP.slug).maybeSingle();
  const gid = (g as { id: string } | null)?.id ?? null;
  const { data: ts } = await db().from("tournaments").select("id").in("slug", EVENTS.map((e) => e.slug));
  const tids = ((ts ?? []) as { id: string }[]).map((t) => t.id);
  if (gid) {
    const { data: refs } = await db().from("referees").select("id").eq("organization_id", MB).eq("event_group_id", gid);
    const refIds = ((refs ?? []) as { id: string }[]).map((r) => r.id);
    if (refIds.length) {
      await db().from("assistance_calls").delete().in("referee_id", refIds);
      await db().from("referee_sessions").delete().in("referee_id", refIds);
    }
    await db().from("organization_codes").delete().eq("event_group_id", gid);
    if (refIds.length) {
      await db().from("organization_codes").delete().in("referee_id", refIds);
      await db().from("referees").delete().in("id", refIds);
    }
  }
  for (const tid of tids) {
    await db().from("organization_codes").delete().eq("tournament_id", tid);
    for (const table of ["coach_sessions", "coach_codes", "assistance_calls", "match_calls", "follows", "notification_events"]) {
      const { error } = await db().from(table).delete().eq("tournament_id", tid);
      if (error && !/column|does not exist|relation/i.test(error.message)) console.warn(`${table}: ${error.message}`);
    }
    const { error } = await db().from("tournaments").delete().eq("id", tid);
    if (error) throw new Error(`tournaments: ${error.message}`);
  }
  if (gid) await db().from("event_groups").delete().eq("id", gid);
  return Boolean(gid || tids.length);
}

/* ---------------- create ---------------- */
type EventOut = { name: string; slug: string; publicUrl: string; courts: { court: string; tie: string; notBefore: string }[] };

async function createEvent(MB: string, gid: string, ev: (typeof EVENTS)[number], today: string, dayOf: (n: number) => string): Promise<EventOut> {
  const t = await must<{ id: string }>(
    db()
      .from("tournaments")
      .insert({
        name: ev.name,
        slug: ev.slug,
        sport: "tennis",
        kind: "tournament",
        status: "active",
        is_demo: false,
        public_access_enabled: true,
        organization_id: MB,
        event_group_id: gid,
        created_by: "admin",
        timezone: TZ,
        starts_on: today,
        ends_on: dayOf(13),
        venue_name: "Smash Sporting Club",
        city: "Cairo",
        scoring_config: DEFAULT_TENNIS_SCORING_CONFIG,
        format_config: { type: "group_knockout", qualifyPerGroup: 2, thirdPlaceMatch: false, ties: { rubbers: ["S2", "S1", "D"] } },
        match_day_rules: newTournamentMatchDayRules("tennis"),
        lower_third_text: `${ev.short} · Umpire Demo · practice event`,
      })
      .select("id")
      .single(),
    `${ev.slug}: tournament`,
  );
  const tid = t.id;
  const courtNames = ev.courts.map((n) => `Court ${n}`);
  const cs = await must<{ id: string; court_name: string }[]>(
    db().from("courts").insert(courtNames.map((court_name, i) => ({ tournament_id: tid, court_name, court_order: i + 1 }))).select("id, court_name"),
    `${ev.slug}: courts`,
  );
  const courtId = new Map(cs.map((c) => [c.court_name, c.id]));

  const teamOf = new Map<string, { id: string; players: string[] }>();
  for (const [i, [code, surnames, boys, girls]] of SQUADS.entries()) {
    const n = nationByCode(code)!;
    const team = await must<{ id: string }>(
      db()
        .from("teams")
        .insert({ tournament_id: tid, team_name: n.name, nation_code: code, iso2: n.iso2, captain_name: `Captain of ${n.name}`, seed_number: i + 1, check_in_status: "checked_in", team_status: "active" })
        .select("id")
        .single(),
      `${ev.slug}: team ${code}`,
    );
    const first = ev.boys ? boys : girls;
    const ps = await must<{ id: string; player_order: number }[]>(
      db()
        .from("players")
        .insert(surnames.map((s, j) => ({ tournament_id: tid, team_id: team.id, player_order: j + 1, full_name: `${first[j]} ${s}` })))
        .select("id, player_order"),
      `${ev.slug}: players ${code}`,
    );
    teamOf.set(code, { id: team.id, players: ps.sort((a, b) => a.player_order - b.player_order).map((p) => p.id) });
  }
  const codeOfTeam = new Map([...teamOf].map(([c, x]) => [x.id, c]));

  // Four groups of four (seeded snake), the app's own draw.
  const groupNames = ["Group A", "Group B", "Group C", "Group D"];
  const gs = await must<{ id: string; group_name: string }[]>(
    db().from("groups").insert(groupNames.map((group_name, i) => ({ tournament_id: tid, group_name, group_order: i + 1, status: "published" }))).select("id, group_name"),
    `${ev.slug}: groups`,
  );
  const groupId = new Map(gs.map((g) => [g.group_name, g.id]));
  const snake = [0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0];
  await must(
    db().from("group_teams").insert(SQUADS.map(([code], i) => ({ tournament_id: tid, group_id: groupId.get(groupNames[snake[i]])!, team_id: teamOf.get(code)!.id, position: Math.floor(i / 4) + 1 }))),
    `${ev.slug}: group teams`,
  );
  await generateGroupTies(tid, "admin");
  const ties = await getTies(tid);
  const round = (r: number) => ties.filter((x) => x.round_no === r).sort((a, b) => (a.tie_order ?? 0) - (b.tie_order ?? 0));
  const label = (x: Tie) => `${codeOfTeam.get(x.team_a_id!)} v ${codeOfTeam.get(x.team_b_id!)}`;

  // Round 1 today: one tie per court, first ball 10:00, then every half hour, so every court has a match to open.
  const out: EventOut["courts"] = [];
  const r1 = round(1);
  if (r1.length < courtNames.length) throw new Error(`${ev.slug}: only ${r1.length} round-1 ties for ${courtNames.length} courts`);
  for (const [i, c] of courtNames.entries()) {
    const local = `${today}T${String(10 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`;
    const at = zonedToIso(local, TZ)!;
    const x = r1[i];
    const r = await scheduleTie(tid, x.id, courtId.get(c)!, at, "admin");
    if (!r.ok) throw new Error(`${ev.slug}: schedule ${label(x)}: ${r.message}`);
    for (const side of ["A", "B"] as const) {
      const s = teamOf.get(codeOfTeam.get((side === "A" ? x.team_a_id : x.team_b_id)!)!)!.players;
      const l = await setLineup(tid, x.id, side, { S1: s[0], S2: s[1], D: [s[2], s[3]] }, "admin");
      if (!l.ok) throw new Error(`${ev.slug}: line-up ${label(x)} ${side}: ${l.message}`);
    }
    const lock = await lockLineups(tid, x.id, "admin");
    if (!lock.ok) throw new Error(`${ev.slug}: lock ${label(x)}: ${lock.message}`);
    out.push({ court: c, tie: label(x), notBefore: local.slice(11) });
  }
  // Rounds 2 and 3 on the next two days, same courts.
  for (const r of [2, 3]) {
    for (const [i, x] of round(r).entries()) {
      const c = courtNames[i % courtNames.length];
      const res = await scheduleTie(tid, x.id, courtId.get(c)!, zonedToIso(`${dayOf(r - 1)}T${i < 8 ? "10:00" : "14:00"}`, TZ)!, "admin");
      if (!res.ok) throw new Error(`${ev.slug}: schedule round ${r}: ${res.message}`);
    }
  }
  return { name: ev.name, slug: ev.slug, publicUrl: `${SITE}/t/${ev.slug}`, courts: out };
}

/** A 4-digit PIN no active referee of the organisation holds (the database refuses a duplicate). */
async function insertReferee(MB: string, gid: string, name: string, role: "referee" | "master_referee", used: Set<string>): Promise<{ id: string; pin: string }> {
  for (let tries = 0; tries < 60; tries++) {
    const pin = String(1000 + Math.floor(Math.random() * 9000));
    if (used.has(pin) || /^(\d)\1{3}$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) continue;
    const { data, error } = await db()
      .from("referees")
      .insert({ organization_id: MB, event_group_id: gid, name, role, pin_hash: hashRefereePin(MB, pin), created_by_role: "admin" })
      .select("id")
      .single();
    if (!error) {
      used.add(pin);
      return { id: (data as { id: string }).id, pin };
    }
    if (!/duplicate|unique/i.test(error.message)) throw new Error(`referee ${name}: ${error.message}`);
    used.add(pin);
  }
  throw new Error(`referee ${name}: no free PIN`);
}

async function create(MB: string, where: string) {
  const today = eventDay(TZ);
  const dayOf = (n: number) => eventDay(TZ, Date.parse(`${today}T12:00:00Z`) + n * 86_400_000);
  const g = await must<{ id: string }>(
    db()
      .from("event_groups")
      .insert({ slug: GROUP.slug, name: GROUP.name, subtitle: "Practice event for chair umpires", venue_name: "Smash Sporting Club", city: "Cairo", country_code: "EG", timezone: TZ, starts_on: today, ends_on: dayOf(13), organization_id: MB })
      .select("id")
      .single(),
    "event group",
  );
  const events: EventOut[] = [];
  for (const ev of EVENTS) events.push(await createEvent(MB, g.id, ev, today, dayOf));

  const expiresAt = zonedToIso(`${dayOf(13)}T23:59`, TZ)!;
  const used = new Set<string>();
  const umpires: { name: string; pin: string }[] = [];
  for (const name of UMPIRES) umpires.push({ name, pin: (await insertReferee(MB, g.id, name, "referee", used)).pin });
  const master = await insertReferee(MB, g.id, MASTER, "master_referee", used);

  const taken = new Set<string>();
  const courtCodes: { court: string; event: string; code: string; qr: string }[] = [];
  for (const ev of EVENTS) {
    for (const n of ev.courts) {
      const court = `Court ${n}`;
      const { code, hash } = await freshShortRefereeCode(taken);
      await must(
        db().from("organization_codes").insert({ organization_id: MB, role: "referee", tournament_id: null, event_group_id: g.id, court_name: court, code_hash: hash, code_sealed: sealEventCode(code), label: courtCodeLabel(court), expires_at: expiresAt, created_by_role: "admin" }),
        `court code ${court}`,
      );
      courtCodes.push({ court, event: ev.short, code: formatEventCode(code), qr: courtLink(SITE, formatEventCode(code)) });
    }
  }
  courtCodes.sort((a, b) => Number(a.court.slice(6)) - Number(b.court.slice(6)));
  let mcode = generateShortRefereeCode();
  while (taken.has(mcode)) mcode = generateShortRefereeCode();
  await must(
    db().from("organization_codes").insert({ organization_id: MB, role: "master_referee", referee_id: master.id, event_group_id: g.id, code_hash: hashEventCode(mcode), code_sealed: sealEventCode(mcode), label: `${MASTER} (master referee)`, expires_at: expiresAt, created_by_role: "admin" }),
    "master code",
  );

  const result = {
    target: where,
    createdAt: new Date().toISOString(),
    expires: dayOf(13),
    eventGroup: GROUP.name,
    events,
    courtCodes,
    umpires,
    master: { name: MASTER, pin: master.pin, code: formatEventCode(mcode) },
  };
  const outPath = process.env.OUT ?? "/tmp/umpire-demo-codes.json";
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`✅ ${GROUP.name} on the ${where} project — ${events.map((e) => e.publicUrl).join(" · ")}`);
  console.log(`   ${courtCodes.length} court codes, ${umpires.length} chair umpires, 1 master referee — codes and PINs written to ${outPath} (keep it private)`);
}

async function main() {
  const where = target();
  const MB = await moveBeyond();
  const removed = await remove(MB);
  if (process.argv[2] === "remove") {
    console.log(removed ? `removed ${GROUP.name}` : `nothing to remove (${GROUP.name})`);
    return;
  }
  await create(MB, where);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
