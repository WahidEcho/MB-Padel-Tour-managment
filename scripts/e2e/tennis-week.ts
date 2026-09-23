/**
 * Week rehearsal for the Junior Team Finals: both events, 16 nations each, run
 * from the draw to 16th place on their own courts, with the three things a real
 * week throws at the desk:
 *
 * - a late line-up change, after the lock, with its reason on record;
 * - an offline referee: a phone scores 30 points with no signal, then syncs them
 *   in one batch, re-sends the same batch after a timeout, and a second phone is
 *   turned away;
 * - rain on both TV courts: rubbers suspended, the walls on a break, the order of
 *   play pushed back an hour, then play resumed and finished.
 *
 * The boys' event plays its feature ties on Court 1, the girls' on Court 2, each
 * court with its own TV — one event per TV. Days are compressed; everything else
 * is the app's own path: the events endpoint for the scenarios, the server
 * functions for the bulk of the week, the walls and public pages over HTTP.
 *
 * Creates and deletes its own data. Needs the app on BASE_URL.
 *
 *   npx tsx --env-file=.env.localdb scripts/e2e/tennis-week.ts
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { finalizeMatch, generateGroupMatches, upsertSnapshotFromState } from "../../src/lib/ops";
import { ensureMainScreen } from "../../src/lib/screens";
import { applyCommandToScreens } from "../../src/lib/tv/commandsServer";
import { getMatches, getTeams, getTournament } from "../../src/lib/data";
import { delayOrderOfPlay, drawPlacement, finalPlacings, getTies, lockLineups, scheduleTie, setLineup } from "../../src/lib/tennis/tieOps";
import { NATIONS } from "../../src/lib/tennis/nations";
import { zonedToIso } from "../../src/lib/tennis/ties";
import type { LiveFeed } from "../../src/lib/tv/liveFeed";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Match, type Tie, type Tournament } from "../../src/lib/types";
import { BASE_URL, authHeaders } from "./lib/session";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const phase = (name: string) => console.log(`\n━━ ${name} ━━`);

async function http(path: string, init: RequestInit = {}, role: "admin" | "referee" = "admin") {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { ...authHeaders(role), ...(init.headers as Record<string, string>) }, redirect: "manual" });
  return { status: res.status, text: await res.text() };
}

let seed = 17;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const rules = (t: Tournament, m: Match) => scoringConfigForMatch(t, m, null, { doubles: m.rubber_type === "D" });

function playTo(t: Tournament, m: Match, winner: TeamKey, from = initialScoreState("A"), strength = 0.62): ScoreState[] {
  const cfg = rules(t, m);
  const loser: TeamKey = winner === "A" ? "B" : "A";
  let s = from;
  const trail = [s];
  while (!s.matchOver) {
    s = awardPoint(s, rand() < strength ? winner : loser, cfg);
    trail.push(s);
    if (trail.length > 3000) throw new Error("runaway rubber");
  }
  return s.winner === winner ? trail : playTo(t, m, winner, from, Math.min(0.95, strength + 0.1));
}

async function finishDirect(t: Tournament, m: Match, winner: TeamKey) {
  const trail = playTo(t, m, winner);
  await upsertSnapshotFromState(m, trail[trail.length - 1], trail.length);
  await finalizeMatch(m, { status: "completed", winnerTeamId: winner === "A" ? m.team_a_id! : m.team_b_id!, actorRole: "e2e" });
}

/** A referee's phone: it keeps its own event numbers and can hold events back, as offline. */
class Phone {
  readonly deviceId = `week-${randomUUID()}`;
  n = 0;
  state: ScoreState = initialScoreState("A");
  queue: object[] = [];
  constructor(readonly t: Tournament, readonly m: Match) {}
  event(type: string, prev: ScoreState | null, next: ScoreState, teamId: string | null = null, payload: unknown = null) {
    this.queue.push({ client_event_id: randomUUID(), event_number: ++this.n, event_type: type, team_id: teamId, previous_state: prev, new_state: next, payload, created_at_client: new Date().toISOString() });
  }
  async claim() {
    return http(`/api/matches/${this.m.id}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: this.deviceId }) }, "referee");
  }
  async sync(events = this.queue) {
    const res = await http(`/api/matches/${this.m.id}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: this.deviceId, events }) }, "referee");
    if (res.status === 200 && events === this.queue) this.queue = [];
    return res;
  }
  start() {
    this.event("MATCH_STARTED", null, this.state, null, { first_server: "A" });
  }
  points(count: number, side: () => TeamKey) {
    const cfg = rules(this.t, this.m);
    for (let i = 0; i < count && !this.state.matchOver; i++) {
      const next = awardPoint(this.state, side(), cfg);
      this.event("POINT_AWARDED", this.state, next);
      this.state = next;
    }
  }
  async finish(winner: TeamKey) {
    const trail = playTo(this.t, this.m, winner, this.state);
    for (let i = 1; i < trail.length; i++) this.event("POINT_AWARDED", trail[i - 1], trail[i]);
    this.state = trail[trail.length - 1];
    const wid = winner === "A" ? this.m.team_a_id! : this.m.team_b_id!;
    this.event("MATCH_ENDED", this.state, this.state, wid, { winner_team_id: wid });
    const res = await this.sync();
    if (res.status !== 200) throw new Error(`finish ${res.status} ${res.text}`);
  }
}

interface Event {
  key: "boys" | "girls";
  name: string;
  tvCourt: 1 | 2;
  codes: string[];
}
const EVENTS: Event[] = [
  { key: "boys", name: "E2E Davis Cup Junior Finals", tvCourt: 1, codes: ["USA", "JPN", "CZE", "ESP", "FRA", "ITA", "AUS", "GER", "ARG", "CAN", "EGY", "IND", "BRA", "KOR", "GBR", "CHI"] },
  { key: "girls", name: "E2E Billie Jean King Cup Junior Finals", tvCourt: 2, codes: ["USA", "ROU", "CZE", "CAN", "SVK", "POL", "JPN", "EGY", "ESP", "UKR", "AUS", "GBR", "CRO", "BEL", "NED", "MEX"] },
];
/** Day one, Cairo time. */
const DAY1 = "2026-11-02";

async function setUp(ev: Event): Promise<{ t: Tournament; courts: { id: string; name: string }[] }> {
  const { data, error } = await db()
    .from("tournaments")
    .insert({
      name: ev.name,
      slug: `e2e-week-${ev.key}-${Date.now()}`,
      sport: "tennis",
      status: "active",
      is_demo: true,
      public_access_enabled: true,
      scoring_config: { ...DEFAULT_TENNIS_SCORING_CONFIG, requireResultConfirmation: true },
      format_config: { type: "group_knockout", qualifyPerGroup: 2, thirdPlaceMatch: false, ties: {} },
    })
    .select()
    .single();
  if (error || !data) throw new Error(error?.message ?? "no tournament");
  const tid = data.id as string;
  await ensureMainScreen(tid);
  // The TV court first, then three outside courts.
  const names = [`Court ${ev.tvCourt}`, ...(ev.tvCourt === 1 ? ["Court 3", "Court 4", "Court 5"] : ["Court 6", "Court 7", "Court 8"])];
  const { data: courts } = await db().from("courts").insert(names.map((court_name, i) => ({ tournament_id: tid, court_name, court_order: i + 1 }))).select();
  const tv = courts!.find((c) => c.court_name === names[0])!;
  await db().from("screen_settings").insert({ tournament_id: tid, screen_key: `court-${ev.tvCourt}-tv`, screen_name: `Court ${ev.tvCourt} TV`, display_mode: "live", court_ids: [tv.id], focus_court_id: tv.id });
  for (const [i, code] of ev.codes.entries()) {
    const nation = NATIONS.find((n) => n.code === code)!;
    const { data: team } = await db()
      .from("teams")
      .insert({ tournament_id: tid, team_name: nation.name, nation_code: code, iso2: nation.iso2, captain_name: `Captain ${code}`, seed_number: i + 1, check_in_status: "checked_in" })
      .select()
      .single();
    await db().from("players").insert([1, 2, 3].map((n) => ({ tournament_id: tid, team_id: team!.id, player_order: n, full_name: `${ev.key === "boys" ? "Boy" : "Girl"} ${code} ${n}` })));
  }
  const teams = (await getTeams(tid)).sort((a, b) => a.seed_number! - b.seed_number!);
  const { data: groups } = await db()
    .from("groups")
    .insert(["A", "B", "C", "D"].map((g, i) => ({ tournament_id: tid, group_name: `Group ${g}`, group_order: i + 1, status: "published" })))
    .select();
  const g = groups!.sort((a, b) => a.group_order - b.group_order);
  const snake = (i: number) => (Math.floor(i / 4) % 2 === 0 ? i % 4 : 3 - (i % 4));
  await db().from("group_teams").insert(teams.map((team, i) => ({ tournament_id: tid, group_id: g[snake(i)].id, team_id: team.id, position: Math.floor(i / 4) + 1 })));
  await generateGroupMatches(tid, "e2e");
  return { t: (await getTournament(tid))!, courts: courts!.map((c) => ({ id: c.id, name: c.court_name })) };
}

async function nominateAll(t: Tournament, ties: Tie[]) {
  const teams = await getTeams(t.id);
  const squad = (id: string) => teams.find((x) => x.id === id)!.players!.sort((a, b) => a.player_order - b.player_order).map((p) => p.id);
  for (const tie of ties) {
    for (const side of ["A", "B"] as const) {
      const s = squad((side === "A" ? tie.team_a_id : tie.team_b_id)!);
      const r = await setLineup(tie.id, side, { S1: s[0], S2: s[1], D: [s[0], s[2]] }, "e2e");
      if (!r.ok) throw new Error(r.message);
    }
    await lockLineups(tie.id, "e2e");
  }
}

/** Plays every open rubber of these ties through the server functions: the better seed usually wins. */
async function playTies(t: Tournament, ties: Tie[]) {
  const teams = await getTeams(t.id);
  const seedOf = (id: string) => teams.find((x) => x.id === id)!.seed_number!;
  for (const tie of ties) {
    const rs = (await getMatches(t.id)).filter((m) => m.tie_id === tie.id).sort((a, b) => a.rubber_no! - b.rubber_no!);
    const fav: TeamKey = seedOf(tie.team_a_id!) < seedOf(tie.team_b_id!) ? "A" : "B";
    for (const r of rs) {
      const now = (await getMatches(t.id)).find((m) => m.id === r.id)!;
      if (!["scheduled", "ready"].includes(now.status)) continue;
      await finishDirect(t, now, r.rubber_type === "D" && rand() < 0.3 ? (fav === "A" ? "B" : "A") : fav);
    }
  }
}

async function feed(t: Tournament, screen: string): Promise<LiveFeed> {
  const res = await fetch(`${BASE_URL}/api/t/${t.slug}/live?screen=${screen}`);
  return (await res.json()) as LiveFeed;
}

async function main() {
  const made: string[] = [];
  try {
    phase("Set-up: two events, 16 nations each, one TV court each");
    const events = [];
    for (const ev of EVENTS) {
      const e = await setUp(ev);
      made.push(e.t.id);
      events.push({ ev, ...e });
      const ties = await getTies(e.t.id);
      check(`${ev.name}: 24 group ties, 72 rubbers`, ties.length === 24 && (await getMatches(e.t.id)).length === 72);
    }

    phase("Day 1 — order of play");
    // Each round of group ties on its own day; the TV court takes each day's first
    // tie at 09:30, the outside courts theirs, a tie every three hours after.
    for (const { t, courts } of events) {
      const ties = (await getTies(t.id)).sort((a, b) => a.tie_order - b.tie_order);
      for (const round of [1, 2, 3]) {
        const day = new Date(Date.parse(`${DAY1}T00:00:00Z`) + (round - 1) * 86_400_000).toISOString().slice(0, 10);
        const list = ties.filter((x) => x.round_no === round);
        for (const [i, tie] of list.entries()) {
          const court = courts[i % courts.length];
          const slot = Math.floor(i / courts.length);
          const r = await scheduleTie(tie.id, court.id, zonedToIso(`${day}T${String(9 + slot * 3).padStart(2, "0")}:30`), "e2e");
          if (!r.ok) throw new Error(r.message);
        }
      }
      const first = (await getTies(t.id)).filter((x) => x.round_no === 1).sort((a, b) => a.tie_order - b.tie_order)[0];
      const rs = (await getMatches(t.id)).filter((m) => m.tie_id === first.id).sort((a, b) => a.rubber_no! - b.rubber_no!);
      check(
        `${t.name}: tie 1 on the TV court at 09:30 Cairo, its rubbers at 09:30, 11:00, 12:30`,
        first.court_id === courts[0].id &&
          Date.parse(first.scheduled_time!) === Date.parse("2026-11-02T07:30:00Z") &&
          rs.map((m) => new Date(m.scheduled_time!).toISOString().slice(11, 16)).join(",") === "07:30,09:00,10:30",
        `${first.scheduled_time} · ${rs.map((m) => m.scheduled_time).join(",")}`,
      );
      await nominateAll(t, (await getTies(t.id)).filter((x) => x.round_no === 1));
    }

    const [boys, girls] = events;
    const featureTie = async (t: Tournament, courtId: string) =>
      (await getTies(t.id)).filter((x) => x.court_id === courtId && x.round_no === 1).sort((a, b) => a.tie_order - b.tie_order)[0];
    const bTie = await featureTie(boys.t, boys.courts[0].id);
    const gTie = await featureTie(girls.t, girls.courts[0].id);

    phase("Day 1 — a late line-up change");
    {
      const teams = await getTeams(girls.t.id);
      const s = teams.find((x) => x.id === gTie.team_a_id)!.players!.sort((a, b) => a.player_order - b.player_order).map((p) => p.id);
      const refused = await setLineup(gTie.id, "A", { S1: s[2], S2: s[1], D: [s[0], s[1]] }, "e2e");
      check("after the lock, a change without a reason is refused", !refused.ok);
      const ok = await setLineup(gTie.id, "A", { S1: s[2], S2: s[1], D: [s[0], s[1]] }, "e2e", { lateChangeReason: "No. 1 player ill overnight" });
      const s1 = (await getMatches(girls.t.id)).find((m) => m.tie_id === gTie.id && m.rubber_type === "S1")!;
      check("with a reason it goes through, and the rubber has the new player", ok.ok && s1.team_a_player_ids?.[0] === s[2]);
      const wall = await http(`/t/${girls.t.slug}/screen/court-2-tv`);
      check("the Court 2 TV opens on the line-up with the new name", wall.status === 200 && wall.text.includes(`Girl ${teams.find((x) => x.id === gTie.team_a_id)!.nation_code} 3`), String(wall.status));
    }

    phase("Day 1 — an offline referee");
    const bS2 = (await getMatches(boys.t.id)).find((m) => m.tie_id === bTie.id && m.rubber_type === "S2")!;
    const phone = new Phone(boys.t, bS2);
    check("the phone claims the rubber while it has signal", (await phone.claim()).status === 200);
    phone.start();
    phone.points(30, () => (rand() < 0.6 ? "A" : "B"));
    check("no signal: 31 events wait on the phone", phone.queue.length === 31);
    const batch = [...phone.queue];
    const synced = await phone.sync();
    const { data: snap } = await db().from("match_score_snapshots").select("last_event_number, team_a_games, team_b_games").eq("match_id", bS2.id).single();
    check("signal back: the batch lands in one request, in order", synced.status === 200 && snap?.last_event_number === 31, `${synced.status} · event ${snap?.last_event_number}`);
    check("…and the score matches the phone", snap?.team_a_games === phone.state.teamA.games && snap?.team_b_games === phone.state.teamB.games);
    const resent = await phone.sync(batch);
    const { count: stored } = await db().from("score_events").select("id", { count: "exact", head: true }).eq("match_id", bS2.id);
    check("the same batch sent again after a timeout is not counted twice", resent.status === 200 && stored === 31, `${resent.status} · ${stored} events stored`);
    const other = new Phone(boys.t, bS2);
    const denied = JSON.parse((await other.claim()).text) as { controller: boolean; locked: boolean };
    other.n = 31;
    other.event("POINT_AWARDED", phone.state, awardPoint(phone.state, "B", rules(boys.t, bS2)));
    const refusedPost = await other.sync();
    check("a second phone is told the rubber is held, and its points are refused", !denied.controller && denied.locked && refusedPost.status === 409, `${JSON.stringify(denied)} · ${refusedPost.status}`);
    const bFeed = await feed(boys.t, "court-1-tv");
    check("the Court 1 TV feed has the rubber live with the synced score", bFeed.matches.some((m) => m.id === bS2.id && m.status === "live") && bFeed.snapshots.find((x) => x.match_id === bS2.id)?.last_event_number === 31);

    phase("Day 1 — rain on both TV courts");
    const gS2 = (await getMatches(girls.t.id)).find((m) => m.tie_id === gTie.id && m.rubber_type === "S2")!;
    const gPhone = new Phone(girls.t, gS2);
    await gPhone.claim();
    gPhone.start();
    gPhone.points(12, () => (rand() < 0.5 ? "A" : "B"));
    await gPhone.sync();
    for (const p of [phone, gPhone]) {
      p.event("MATCH_PAUSED", p.state, p.state, null, { reason: "Rain" });
      const r = await p.sync();
      if (r.status !== 200) throw new Error(`pause ${r.status} ${r.text}`);
    }
    const paused = [...(await getMatches(boys.t.id)), ...(await getMatches(girls.t.id))].filter((m) => m.status === "paused");
    check("both TV-court rubbers suspended", paused.length === 2);
    for (const { t } of events) await applyCommandToScreens(t.id, [], { kind: "break_start", minutes: 45 }, "operator");
    const wallFeeds = [await feed(boys.t, "court-1-tv"), await feed(girls.t, "court-2-tv")];
    check("both walls go to a break with a countdown", wallFeeds.every((f) => f.screen.break_ends_at && Date.parse(f.screen.break_ends_at) > Date.now()));
    const laterTie = (await getTies(boys.t.id)).find((x) => x.round_no === 1 && x.court_id === boys.courts[0].id && x.id !== bTie.id && x.status === "scheduled")!;
    const before = { tie: laterTie.scheduled_time, s1: (await getMatches(boys.t.id)).find((m) => m.tie_id === bTie.id && m.rubber_type === "S1")!.scheduled_time };
    const delayed = [await delayOrderOfPlay(boys.t.id, 60, null, "manager"), await delayOrderOfPlay(girls.t.id, 60, null, "manager")];
    check("the order of play goes back an hour in both events", delayed.every((d) => d.ok && d.ties > 0 && d.rubbers > 0), JSON.stringify(delayed));
    const afterTie = (await getTies(boys.t.id)).find((x) => x.id === laterTie.id)!;
    const afterRubbers = await getMatches(boys.t.id);
    check("a later tie on Court 1 moved from 12:30 to 13:30", Date.parse(afterTie.scheduled_time!) - Date.parse(before.tie!) === 3_600_000, `${before.tie} → ${afterTie.scheduled_time}`);
    check("the next rubber of the suspended tie moved too", Date.parse(afterRubbers.find((m) => m.tie_id === bTie.id && m.rubber_type === "S1")!.scheduled_time!) - Date.parse(before.s1!) === 3_600_000);
    check("the suspended rubber itself did not move", afterRubbers.find((m) => m.id === bS2.id)!.scheduled_time === bS2.scheduled_time);
    const { count: delayAudits } = await db().from("audit_logs").select("id", { count: "exact", head: true }).in("tournament_id", made).eq("action", "ORDER_OF_PLAY_DELAYED");
    check("both delays are on the record", delayAudits === 2, String(delayAudits));
    for (const { t } of events) await applyCommandToScreens(t.id, [], { kind: "break_end" }, "operator");
    for (const p of [phone, gPhone]) {
      p.event("MATCH_RESUMED", p.state, p.state);
      await p.sync();
    }
    check("play resumes: walls off the break", (await Promise.all([feed(boys.t, "court-1-tv"), feed(girls.t, "court-2-tv")])).every((f) => !f.screen.break_ends_at));
    await phone.finish("A");
    await gPhone.finish("B");
    check("both rubbers finished after the rain", (await getMatches(boys.t.id)).find((m) => m.id === bS2.id)!.status === "completed" && (await getMatches(girls.t.id)).find((m) => m.id === gS2.id)!.status === "completed");

    phase("Days 1–3 — the group stage");
    for (const { t } of events) {
      for (const round of [1, 2, 3]) {
        const list = (await getTies(t.id)).filter((x) => x.round_no === round && x.stage === "group");
        if (round > 1) await nominateAll(t, list);
        await playTies(t, list);
      }
      const ties = await getTies(t.id);
      check(`${t.name}: all 24 group ties finished`, ties.every((x) => x.status === "completed"), ties.filter((x) => x.status !== "completed").length + " open");
    }

    phase("Days 4–6 — placement draws, every place to 16th");
    for (const { t } of events) {
      const drawn = await drawPlacement(t.id, "e2e");
      check(`${t.name}: placement draws made`, drawn.ok && drawn.ties === 24, drawn.ok ? String(drawn.ties) : drawn.message);
      for (const round of [1, 2, 3]) {
        const list = (await getTies(t.id)).filter((x) => x.stage === "placement" && x.round_no === round);
        await nominateAll(t, list);
        await playTies(t, list);
      }
      const places = await finalPlacings(t.id);
      const teams = await getTeams(t.id);
      check(`${t.name}: every place from 1st to 16th, each nation once`, places.length === 16 && new Set(places.map((p) => p.team_id)).size === 16);
      console.log(`   ${t.name} champion: ${teams.find((x) => x.id === places[0].team_id)!.team_name}`);
    }

    phase("The walls and the public pages at the end of the week");
    for (const { ev, t } of events) {
      const wall = await http(`/t/${t.slug}/screen/court-${ev.tvCourt}-tv`);
      check(`${t.name}: the Court ${ev.tvCourt} TV renders`, wall.status === 200 && wall.text.includes("data-scene"), String(wall.status));
      for (const p of ["", "/matches", "/leaderboard", "/live"]) {
        const r = await fetch(`${BASE_URL}/t/${t.slug}${p}`);
        check(`${t.name}: public /t/…${p || "/"} renders`, r.status === 200, String(r.status));
      }
      const tiesPage = await http(`/admin/tournaments/${t.id}/ties`);
      check(`${t.name}: the Ties page shows the final places`, tiesPage.status === 200 && tiesPage.text.includes('data-testid="final-placings"'));
    }
  } catch (e) {
    check("the week ran to the end", false, e instanceof Error ? e.stack ?? e.message : String(e));
  } finally {
    for (const id of made) await db().from("tournaments").delete().eq("id", id);
    const { count } = await db().from("matches").select("id", { count: "exact", head: true }).in("tournament_id", made.length ? made : ["00000000-0000-0000-0000-000000000000"]);
    check("cleanup removed both events", (count ?? 0) === 0);
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
