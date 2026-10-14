/**
 * Leagues (plan Phase 7), end to end on the stand-in.
 *
 *   1. Nights: a night from the template, its table, points on finalise (win 2,
 *      loss 1); an Undo removes them, re-finishing adds them once; a correction
 *      swaps them (still one row per match + player); a walkover (2 / 0); the
 *      month is the night's date, across a time-zone edge.
 *   2. Season fixtures: a dated round robin, a late member, regeneration of the
 *      unplayed fixtures only; streak bonus on and off (recomputed exactly).
 *   3. Boards: monthly, a 3-month block by the league's year start, the year.
 *   4. A tournament counting toward a division: members only, undo and reset
 *      take the points back.
 *   5. Top of all leagues per organisation and platform-wide, with a league that
 *      does not count and an organisation that opted out.
 *   6. Joining: no profile, open, approval, invite code (hashed, never logged),
 *      paid outside Move Beyond (pay at the venue), already a member.
 *   7. App surfaces: league nights in the bundle and the referee list; plain
 *      sessions still hidden.
 *   8. Another organisation's admin: cannot read or change the league, its
 *      members or points, nor count its tournament toward it (nor ours toward its).
 *   9. No private fields on boards and league pages (masked names stay masked).
 *
 * Stand-in only; creates and deletes its own data.
 *
 *   LOCALDB_PORT=54331 npm run localdb                       # terminal 1
 *   npm run build                                            # no `next dev` running
 *   (set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3087 npx next start -p 3087)
 *   npm run e2e:leagues
 */
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { db } from "../../src/lib/supabase";
import { createFriendlySession, generateSchedule } from "../../src/lib/friendly/ops";
import { resetTournamentLiveData } from "../../src/lib/ops";
import { awardPoint, initialScoreState, type ScoreState } from "../../src/lib/scoring/engine";
import { stateFromFinalScore } from "../../src/lib/scoring/finalScore";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { generateEventCode, hashEventCode } from "../../src/lib/orgs/codes";
import { storedLeaguePointsRules, leaguePointsRules } from "../../src/lib/leagues/points";
import { storedNightTemplate, nightTemplate, storedLeaguePeriods, leaguePeriods } from "../../src/lib/leagues/settings";
import { addMember, createLeague, createNight, generateSeasonFixtures, resetInviteCode, setFixtureDate, updateLeague } from "../../src/lib/leagues/ops";
import { recomputeLeague } from "../../src/lib/leagues/server";
import { DEFAULT_SCORING_CONFIG, type Match, type Tournament } from "../../src/lib/types";
import { staffToken } from "./lib/session";
import { appUser, assertStandIn, BASE_URL, bearer, check, cookie, eventually, finish, http, section, sleep, type Who } from "./lib/fixtures";

assertStandIn("leagues.ts");

/* ---------------- server actions, called the way the browser does ---------------- */

interface ManifestEntry {
  filename: string;
  exportedName: string;
  workers: Record<string, unknown>;
}
const manifest = JSON.parse(readFileSync(join(process.cwd(), ".next/server/server-reference-manifest.json"), "utf8")) as { node: Record<string, ManifestEntry> };
const ACTIONS = "src/app/admin/leagues/actions.ts";
/** (state, form) actions: StateForm forms whose refusals come back as { ok: false, message }. */
const STATE_ACTIONS = new Set([
  "createLeagueAction",
  "saveLeagueSettings",
  "addDivisionAction",
  "renameDivisionAction",
  "deleteDivisionAction",
  "createNightAction",
  "deleteNightAction",
  "setFixtureDateAction",
  "generateFixturesAction",
]);

async function action(name: string, form: Record<string, string>, who: Who, pagePath = "/admin/leagues") {
  const sameFile = (f: string) => f === ACTIONS || f.endsWith(`/${ACTIONS}`) || `src/${f}` === ACTIONS;
  const hit = Object.entries(manifest.node).find(([, e]) => sameFile(e.filename) && e.exportedName === name);
  if (!hit) throw new Error(`no server action ${name} in the build manifest (rebuild?)`);
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(`_1_${k}`, v);
  fd.set("0", JSON.stringify(STATE_ACTIONS.has(name) ? [null, "$K1"] : ["$K1"]));
  const res = await fetch(`${BASE_URL}${pagePath}`, { method: "POST", headers: { "Next-Action": hit[0], Accept: "text/x-component", Origin: BASE_URL, ...who }, body: fd, redirect: "manual" });
  return { status: res.status, text: await res.text() };
}
/** Went through: no error, and not a (state, form) action answering { ok: false }. */
const actionOk = (r: { status: number; text: string }) => (r.status === 200 || r.status === 303) && !/"digest"|Not found|Not allowed|"ok":false/.test(r.text);

/* ---------------- scoring through the events route ---------------- */

const DEVICE = `e2e-lg-${randomUUID().slice(0, 8)}`;

function ev(n: number, type: string, prev: unknown, next: unknown, extra: { team_id?: string | null; payload?: Record<string, unknown> | null } = {}) {
  return { client_event_id: randomUUID(), event_number: n, event_type: type, team_id: extra.team_id ?? null, previous_state: prev, new_state: next, payload: extra.payload ?? null, created_at_client: new Date().toISOString() };
}

async function ctx(matchId: string) {
  const { data: m } = await db().from("matches").select("*").eq("id", matchId).single();
  const match = m as Match;
  const { data: t } = await db().from("tournaments").select("*").eq("id", match.tournament_id).single();
  const tournament = t as Tournament;
  const { data: s } = await db().from("match_score_snapshots").select("last_event_number, snapshot_json").eq("match_id", matchId).maybeSingle();
  const snap = s as { last_event_number: number; snapshot_json: ScoreState } | null;
  return {
    match,
    tournament,
    rules: scoringConfigForMatch(tournament, match),
    confirm: tournament.scoring_config?.requireResultConfirmation === true,
    n: snap?.last_event_number ?? 0,
    state: snap?.snapshot_json?.teamA ? snap.snapshot_json : initialScoreState("A"),
  };
}

const send = (matchId: string, who: Who, events: unknown[]) => http("POST", `/api/matches/${matchId}/events`, who, { deviceId: DEVICE, events });

/** Plays the match to a win for `side`, point by point (and confirms when the rules ask). Returns the state before the last point. */
async function play(matchId: string, side: "A" | "B", who: Who) {
  const c = await ctx(matchId);
  let s = c.state;
  let k = c.n;
  const events: ReturnType<typeof ev>[] = [];
  let beforeLast = s;
  while (!s.matchOver) {
    const next = awardPoint(s, side, c.rules);
    beforeLast = s;
    events.push(ev(++k, "POINT_AWARDED", s, next, { team_id: side === "A" ? c.match.team_a_id : c.match.team_b_id }));
    s = next;
  }
  if (c.confirm) events.push(ev(++k, "MATCH_ENDED", s, s, { payload: { winner_team_id: side === "A" ? c.match.team_a_id : c.match.team_b_id } }));
  const r = await send(matchId, who, events);
  if (r.status !== 200) throw new Error(`play ${matchId}: ${r.status} ${r.text.slice(0, 300)}`);
  return { beforeLast, last: s };
}

async function confirmEnd(matchId: string, who: Who) {
  const c = await ctx(matchId);
  const winner = c.state.winner === "A" ? c.match.team_a_id : c.match.team_b_id;
  return send(matchId, who, [ev(c.n + 1, "MATCH_ENDED", c.state, c.state, { payload: { winner_team_id: winner } })]);
}

async function undo(matchId: string, who: Who, to: ScoreState) {
  const c = await ctx(matchId);
  return send(matchId, who, [ev(c.n + 1, "UNDO", c.state, to)]);
}

async function correct(matchId: string, who: Who, sets: { a: number; b: number }[]) {
  const c = await ctx(matchId);
  const built = stateFromFinalScore(c.rules, sets);
  if (!built.ok) throw new Error(`correction fixture: ${JSON.stringify(built.problems)}`);
  const winner = built.state.winner === "A" ? c.match.team_a_id : c.match.team_b_id;
  return send(matchId, who, [ev(c.n + 1, "RESULT_ENTERED", c.state, built.state, { team_id: winner, payload: { sets } })]);
}

async function walkover(matchId: string, who: Who, side: "A" | "B") {
  const c = await ctx(matchId);
  const winner = side === "A" ? c.match.team_a_id : c.match.team_b_id;
  return send(matchId, who, [ev(c.n + 1, "WALKOVER", c.state, c.state, { team_id: winner, payload: { winner_team_id: winner } })]);
}

/* ---------------- rows ---------------- */

interface PointsRow {
  player_profile_id: string;
  match_id: string;
  kind: string;
  points: number;
  month: string;
  components: { base: number; streak: number };
  league_id: string;
}
async function pointsOf(filter: { match?: string; league?: string }): Promise<PointsRow[]> {
  let q = db().from("league_points").select("player_profile_id, match_id, kind, points, month, components, league_id");
  if (filter.match) q = q.eq("match_id", filter.match);
  if (filter.league) q = q.eq("league_id", filter.league);
  const { data } = await q.limit(10000);
  return ((data ?? []) as PointsRow[]).map((r) => ({ ...r, points: Number(r.points) }));
}
const sum = (rows: { points: number }[]) => rows.reduce((n, r) => n + r.points, 0);

async function participants(matchId: string) {
  const { data } = await db().from("friendly_match_participants").select("*").eq("match_id", matchId).single();
  const p = data as { team_a_player_one: string; team_a_player_two: string | null; team_b_player_one: string; team_b_player_two: string | null };
  return { a: [p.team_a_player_one, p.team_a_player_two].filter(Boolean) as string[], b: [p.team_b_player_one, p.team_b_player_two].filter(Boolean) as string[] };
}

async function main() {
  const tag = randomUUID().slice(0, 6);
  const created = { orgs: [] as string[], profiles: [] as string[], users: [] as string[] };
  const ids: Record<string, string> = {};

  try {
    section("0. two organisations, their admins, players");
    const org = async (key: string) => {
      const { data, error } = await db().from("organizations").insert({ slug: `e2e-lg-${key}-${tag}`, name: `E2E League Org ${key.toUpperCase()} ${tag}`, status: "approved" }).select("id, slug").single();
      if (error) throw new Error(error.message);
      created.orgs.push((data as { id: string }).id);
      return data as { id: string; slug: string };
    };
    const A = await org("a");
    const B = await org("b");
    const admin = async (o: { id: string }, key: string) => {
      const u = await appUser(`e2e.lg.${key}.${tag}@example.com`);
      await db().from("organization_members").insert({ organization_id: o.id, auth_user_id: u.userId, invited_email: `e2e.lg.${key}.${tag}@example.com`, role: "admin", status: "active" });
      return cookie(staffToken({ kind: "member", userId: u.userId, orgId: o.id, role: "admin" }));
    };
    const aAdmin = await admin(A, "a");
    const bAdmin = await admin(B, "b");
    const { data: codeRow } = await db().from("organization_codes").insert({ organization_id: A.id, role: "referee", code_hash: hashEventCode(generateEventCode()), label: "e2e" }).select("id").single();
    const aReferee = bearer(staffToken({ kind: "code", codeId: (codeRow as { id: string }).id, orgId: A.id, role: "referee" }));

    const profile = async (name: string, orgId: string | null, extra: Record<string, unknown> = {}, source = "admin") => {
      const { data, error } = await db().from("player_profiles").insert({ public_name: `${name} ${tag}`, approval_status: "approved", ...extra }).select("id").single();
      if (error) throw new Error(error.message);
      const id = (data as { id: string }).id;
      created.profiles.push(id);
      if (orgId) await db().from("organization_players").insert({ organization_id: orgId, player_profile_id: id, source, approval_status: "approved" });
      ids[name] = id;
      return id;
    };
    const P = await Promise.all(["Pa1", "Pa2", "Pa3", "Pa4"].map((n) => profile(n, A.id)));
    const Q = await Promise.all(["Qs1", "Qs2"].map((n) => profile(n, A.id)));
    // Org B registered this person; org A only matched them by a typed mobile.
    const PM = await profile("Secret Realname", B.id, { mobile_normalized: `+2010${tag.replace(/\D/g, "1").slice(0, 4)}9999`, email: `secret.${tag}@example.com` });
    await db().from("organization_players").insert({ organization_id: A.id, player_profile_id: PM, source: "matched", approval_status: "approved", typed_name: `Typed Name ${tag}` });
    const Q4 = await profile("Qs4", A.id);
    const P9 = await profile("Outsider", A.id);
    const PB = await Promise.all(["Pb1", "Pb2"].map((n) => profile(n, B.id)));
    check(true, "orgs, admins and players ready");

    section("1. league nights: points on finalise, undo, correction, walkover, month by night date");
    const LA = await createLeague({ organizationId: A.id, name: `E2E Nights ${tag}`, kind: "nights", sport: "padel", actorRole: "admin" });
    await updateLeague(LA.id, { status: "active", night_template: storedNightTemplate({ ...nightTemplate({}), courts: 1, gamesToWinSet: 2, setsToWinMatch: 1, pairingMode: "americano" }) }, "admin");
    const { data: dRows } = await db().from("league_divisions").select("id").eq("league_id", LA.id);
    const D1 = (dRows as { id: string }[])[0].id;
    for (const p of P) await addMember(LA.id, p, D1, "admin");
    const night = await createNight(D1, "2026-11-01", "admin");
    const { data: entries } = await db().from("friendly_entries").select("player_profile_id").eq("session_id", night.sessionId).eq("approval", "approved");
    check((entries ?? []).length === 4, "a night from the template enters the division's four members", entries?.length);
    await generateSchedule(night.sessionId, "admin");
    const { data: ns } = await db().from("friendly_sessions").select("tournament_id").eq("id", night.sessionId).single();
    const NT = (ns as { tournament_id: string }).tournament_id;
    const { data: nm } = await db().from("matches").select("id").eq("tournament_id", NT).order("match_order");
    const nightMatches = (nm as { id: string }[]).map((m) => m.id);
    check(nightMatches.length >= 2, "the night's table has matches", nightMatches.length);
    const M1 = nightMatches[0];
    const M2 = nightMatches[1];
    const parts1 = await participants(M1);

    const p1 = await play(M1, "A", aAdmin);
    let rows = await pointsOf({ match: M1 });
    check(
      rows.length === 4 && rows.filter((r) => parts1.a.includes(r.player_profile_id)).every((r) => r.kind === "win" && r.points === 2) && rows.filter((r) => parts1.b.includes(r.player_profile_id)).every((r) => r.kind === "loss" && r.points === 1),
      "finalised: winners 2, losers 1 (defaults)",
      rows,
    );
    check(rows.every((r) => r.month === "2026-11" && r.components.streak === 0), "the month is the night's date (2026-11), not today; no streak bonus (off by default)", rows.map((r) => r.month));
    // Ledger for the night table still works (stand-alone friendly rules untouched).
    const { count: ledger } = await db().from("player_score_ledger").select("id", { count: "exact", head: true }).eq("match_id", M1);
    check((ledger ?? 0) >= 4, "the night's own table (friendly ledger) is still written", ledger);

    const u1 = await undo(M1, aAdmin, p1.last);
    rows = await pointsOf({ match: M1 });
    check(u1.status === 200 && rows.length === 0, "Undo past the end removes the match's league points", { status: u1.status, rows: rows.length });
    const again = await confirmEnd(M1, aAdmin);
    rows = await pointsOf({ match: M1 });
    check(again.status === 200 && rows.length === 4, "finishing it again adds them exactly once", rows.length);

    const corr = await correct(M1, aAdmin, [{ a: 0, b: 2 }]);
    if (corr.status !== 200) console.log(corr.text.slice(0, 600));
    rows = await pointsOf({ match: M1 });
    check(
      corr.status === 200 && rows.length === 4 && rows.filter((r) => parts1.b.includes(r.player_profile_id)).every((r) => r.kind === "win" && r.points === 2) && rows.filter((r) => parts1.a.includes(r.player_profile_id)).every((r) => r.kind === "loss"),
      "a correction swaps the points (still one row per match + player)",
      { status: corr.status, rows },
    );
    const { data: corrAudit } = await db().from("audit_logs").select("action").eq("entity_id", M1).eq("action", "RESULT_CORRECTED");
    check((corrAudit ?? []).length === 1, "…and is audited");

    const parts2 = await participants(M2);
    const wo = await walkover(M2, aAdmin, "A");
    rows = await pointsOf({ match: M2 });
    check(
      wo.status === 200 && rows.length === 4 && rows.filter((r) => parts2.a.includes(r.player_profile_id)).every((r) => r.kind === "walkover_win" && r.points === 2) && rows.filter((r) => parts2.b.includes(r.player_profile_id)).every((r) => r.kind === "walkover_loss" && r.points === 0),
      "a walkover: 2 to the side that turned up, 0 to the side that did not",
      { status: wo.status, rows },
    );

    // Time-zone edge: a night on 31 October whose match ended at 01:30 on 1 November in Cairo.
    const edge = await createNight(D1, "2026-10-31", "admin");
    await generateSchedule(edge.sessionId, "admin");
    const { data: es } = await db().from("friendly_sessions").select("tournament_id").eq("id", edge.sessionId).single();
    const { data: em } = await db().from("matches").select("id").eq("tournament_id", (es as { tournament_id: string }).tournament_id).order("match_order").limit(1);
    const ME = (em as { id: string }[])[0].id;
    await play(ME, "A", aAdmin);
    await db().from("matches").update({ ended_at: "2026-10-31T22:30:00Z" }).eq("id", ME);
    await recomputeLeague(LA.id);
    rows = await pointsOf({ match: ME });
    check(rows.length === 4 && rows.every((r) => r.month === "2026-10"), "a match that ended after midnight counts in its night's month (2026-10)", rows.map((r) => r.month));

    section("2. season fixtures: round robin, late member, regeneration, streak on and off");
    const LS = await createLeague({ organizationId: A.id, name: `E2E Season ${tag}`, kind: "season", sport: "padel", actorRole: "admin" });
    await updateLeague(LS.id, { status: "active", night_template: storedNightTemplate({ ...nightTemplate({}), gamesToWinSet: 2, setsToWinMatch: 1 }) }, "admin");
    const { data: sd } = await db().from("league_divisions").select("id").eq("league_id", LS.id);
    const SD = (sd as { id: string }[])[0].id;
    for (const p of [...Q, PM]) await addMember(LS.id, p, SD, "admin");
    const gen = await generateSeasonFixtures(SD, ["2026-11-03", "2026-11-10", "2026-11-17"], "admin");
    check(gen.created === 3 && gen.rounds === 3, "three members: three fixtures over three dated rounds", gen);
    const fixturesOf = async () => {
      const { data } = await db().from("league_fixtures").select("id, match_id, round, date, home_member_id, away_member_id").eq("league_id", LS.id).eq("kind", "match").order("round");
      return (data ?? []) as { id: string; match_id: string; round: number; date: string; home_member_id: string; away_member_id: string }[];
    };
    let fx = await fixturesOf();
    check(fx.map((f) => f.date).join(",") === "2026-11-03,2026-11-10,2026-11-17", "round n on the n-th date", fx.map((f) => f.date));
    const { data: memRows } = await db().from("league_members").select("id, player_profile_id").eq("league_id", LS.id);
    const profileOfMember = new Map(((memRows ?? []) as { id: string; player_profile_id: string }[]).map((m) => [m.id, m.player_profile_id]));
    const Q1 = Q[0];
    const winnerSide = (f: { home_member_id: string; away_member_id: string }) => (profileOfMember.get(f.away_member_id) === Q1 ? "B" : "A");
    await play(fx[0].match_id, winnerSide(fx[0]), aAdmin);
    const playedPair = [fx[0].home_member_id, fx[0].away_member_id].sort().join("|");

    await addMember(LS.id, Q4, SD, "admin");
    const regen = await generateSeasonFixtures(SD, ["2026-11-10", "2026-11-17", "2026-11-24"], "admin");
    fx = await fixturesOf();
    const pairs = fx.map((f) => [f.home_member_id, f.away_member_id].sort().join("|"));
    check(regen.kept === 1 && regen.removed === 2 && regen.created === 5 && fx.length === 6 && new Set(pairs).size === 6, "regenerating keeps the played fixture, replans the rest with the late member", regen);
    check(pairs.filter((p) => p === playedPair).length === 1 && fx.filter((f) => f.round >= 2).every((f) => f.date >= "2026-11-10"), "…the played pairing is not drawn again; new rounds on the new dates", fx.map((f) => `${f.round}:${f.date}`));
    const { count: matchCount } = await db().from("matches").select("id", { count: "exact", head: true }).in("id", fx.map((f) => f.match_id));
    check(matchCount === 6, "every fixture has its match (unplayed ones were replaced, not duplicated)", matchCount);
    // Move one later fixture to December (month boards below).
    const decFixture = fx.find((f) => f.round === Math.max(...fx.map((x) => x.round)))!;
    await setFixtureDate(decFixture.id, "2026-12-01", "admin");
    for (const f of fx.slice(1)) await play(f.match_id, winnerSide(f), aAdmin);
    const q1Rows = (await pointsOf({ league: LS.id })).filter((r) => r.player_profile_id === Q1);
    check(q1Rows.length === 3 && q1Rows.every((r) => r.kind === "win") && sum(q1Rows) === 6, "streak off: three wins are 2 + 2 + 2", q1Rows.map((r) => r.points));
    await updateLeague(LS.id, { points_rules: storedLeaguePointsRules(leaguePointsRules({ streak: { on: true, bonus: 1, from: 2, to: 11 } })) }, "admin");
    let q1On = (await pointsOf({ league: LS.id })).filter((r) => r.player_profile_id === Q1);
    check(sum(q1On) === 8 && q1On.filter((r) => r.components.streak === 1).length === 2 && q1On.length === 3, "streak on (bonus 1 from the 2nd win): 2 + 3 + 3, recomputed once", q1On.map((r) => r.points));
    await updateLeague(LS.id, { points_rules: storedLeaguePointsRules(leaguePointsRules({})) }, "admin");
    q1On = (await pointsOf({ league: LS.id })).filter((r) => r.player_profile_id === Q1);
    check(sum(q1On) === 6 && q1On.length === 3, "streak off again: back to 6, no rows left behind", q1On.map((r) => r.points));

    section("3. boards: monthly, 3-month block by the year start, the year");
    const lsRows = await pointsOf({ league: LS.id });
    const nov = sum(lsRows.filter((r) => r.month === "2026-11"));
    const dec = sum(lsRows.filter((r) => r.month === "2026-12"));
    check(nov > 0 && dec > 0, "the season has November and December points", { nov, dec });
    await updateLeague(LS.id, { periods: storedLeaguePeriods(leaguePeriods({ boards: [1, 3, 12], year_start_month: 9 })) }, "admin");
    const board = async (period: number, month: string) => {
      const r = await eventually(async () => {
        const x = await http("GET", `/api/mobile/v1/leagues/${LS.slug}?period=${period}&month=${month}`);
        return x.status === 200 ? x : null;
      });
      const j = r?.json as { board: { points: number }[]; period: { months: string[] } } | null;
      return { total: sum(j?.board ?? []), months: j?.period.months ?? [], text: r?.text ?? "" };
    };
    let b = await board(1, "2026-11");
    check(b.total === nov && b.months.join() === "2026-11", "the monthly board is that month only", b);
    b = await board(1, "2026-12");
    check(b.total === dec, "…and resets in December", b.total);
    b = await board(3, "2026-11");
    check(b.months.join() === "2026-09,2026-10,2026-11" && b.total === nov, "3 months with the year starting in September: Sep–Nov (December not in it)", b);
    await updateLeague(LS.id, { periods: storedLeaguePeriods(leaguePeriods({ boards: [1, 3, 12], year_start_month: 10 })) }, "admin");
    await sleep(2100);
    b = await board(3, "2026-11");
    check(b.months.join() === "2026-10,2026-11,2026-12" && b.total === nov + dec, "year starting in October: Oct–Dec holds both months", b);
    b = await board(12, "2026-11");
    check(b.months.length === 12 && b.total === nov + dec, "the year board sums every month of the league year", b.months.length);

    section("4. a tournament counting toward a division");
    const { data: tr, error: tre } = await db()
      .from("tournaments")
      .insert({ name: `E2E Counting ${tag}`, slug: `e2e-lg-t-${tag}`, organization_id: A.id, status: "active", is_demo: true, starts_on: "2026-11-20", scoring_config: { ...DEFAULT_SCORING_CONFIG, gamesToWinSet: 2, requireResultConfirmation: false } })
      .select("id")
      .single();
    if (tre) throw new Error(tre.message);
    const TA = (tr as { id: string }).id;
    const team = async (name: string, profiles: string[]) => {
      const { data: t } = await db().from("teams").insert({ tournament_id: TA, team_name: `${name} ${tag}` }).select("id").single();
      const id = (t as { id: string }).id;
      await db().from("players").insert(profiles.map((p, i) => ({ tournament_id: TA, team_id: id, full_name: `${name} P${i + 1}`, player_order: i + 1, player_profile_id: p })));
      return id;
    };
    const tA = await team("Alpha", [P[0], P[1]]);
    const tB = await team("Beta", [P[2], P9]);
    const { data: gm } = await db().from("matches").insert({ tournament_id: TA, stage: "group", round_name: "Group A", match_order: 1, status: "scheduled", team_a_id: tA, team_b_id: tB }).select("id").single();
    const TM = (gm as { id: string }).id;
    const count = await action("setCountsTowardAction", { tournament_id: TA, division_id: D1 }, aAdmin);
    const { data: tcRow } = await db().from("tournaments").select("counts_toward").eq("id", TA).single();
    check(actionOk(count) && (tcRow as { counts_toward: string }).counts_toward === D1, "the organiser counts the tournament toward the division (off by default)", count.text.slice(0, 200));
    const tp = await play(TM, "A", aAdmin);
    rows = await pointsOf({ match: TM });
    check(
      rows.length === 3 && rows.filter((r) => r.kind === "win").map((r) => r.player_profile_id).sort().join() === [P[0], P[1]].sort().join() && rows.some((r) => r.player_profile_id === P[2] && r.kind === "loss") && !rows.some((r) => r.player_profile_id === P9),
      "its matches count for the division's members only (the non-member gets nothing)",
      rows,
    );
    check(rows.every((r) => r.month === "2026-11"), "…in the month of the tournament's start");
    await undo(TM, aAdmin, tp.beforeLast);
    check((await pointsOf({ match: TM })).length === 0, "Undo takes the tournament match's points back");
    await play(TM, "A", aAdmin);
    check((await pointsOf({ match: TM })).length === 3, "…finishing again puts them back once");
    await resetTournamentLiveData(TA, "admin");
    check((await pointsOf({ match: TM })).length === 0, "a reset of the tournament's live data removes them");

    section("5. top of all leagues: per organisation and platform-wide");
    const LB = await createLeague({ organizationId: B.id, name: `E2E B Season ${tag}`, kind: "season", sport: "padel", actorRole: "admin" });
    await updateLeague(LB.id, { status: "active", night_template: storedNightTemplate({ ...nightTemplate({}), gamesToWinSet: 2 }) }, "admin");
    const { data: bd } = await db().from("league_divisions").select("id").eq("league_id", LB.id);
    const BD = (bd as { id: string }[])[0].id;
    for (const p of PB) await addMember(LB.id, p, BD, "admin");
    await generateSeasonFixtures(BD, ["2026-11-05"], "admin");
    const { data: bf } = await db().from("league_fixtures").select("match_id").eq("league_id", LB.id);
    await play((bf as { match_id: string }[])[0].match_id, "A", bAdmin);
    const lbRows = await pointsOf({ league: LB.id });
    const bName = `Pb1 ${tag}`;
    const orgTop = async (slug: string) => (await http("GET", `/api/mobile/v1/orgs/${slug}?month=2026-11`)).json as { topBoard: { lines: { name: string; points: number }[] } | null; leagues: { slug: string }[]; comingSoon: string[] } | null;
    const platform = async () => ((await http("GET", "/api/mobile/v1/leagues/top?month=2026-11")).json as { lines: { name: string; points: number }[] }).lines;
    const q1Nov = sum((await pointsOf({ league: LS.id })).filter((r) => r.player_profile_id === Q1 && r.month === "2026-11"));
    let plat = await platform();
    check(lbRows.length === 2 && plat.some((l) => l.name === bName) && plat.some((l) => l.name === `Qs1 ${tag}` && l.points === q1Nov), "platform board: players of both organisations", plat.slice(0, 6));
    const aOrg = await orgTop(A.slug);
    check(Boolean(aOrg?.topBoard?.lines.some((l) => l.name === `Qs1 ${tag}`)) && !aOrg?.topBoard?.lines.some((l) => l.name === bName), "an organisation's board has its own leagues' players only", aOrg?.topBoard?.lines.slice(0, 5));
    check(JSON.stringify(aOrg?.comingSoon) === "[]" && (aOrg?.leagues.length ?? 0) >= 2, "the organisation page lists its leagues (no more 'coming soon')", aOrg?.leagues);
    await updateLeague(LS.id, { counts_toward_top_of_all: false }, "admin");
    const qGone = await eventually(async () => !(await platform()).some((l) => l.name === `Qs1 ${tag}`), 8000);
    check(qGone, "a league that does not count toward the top boards leaves them");
    await updateLeague(LS.id, { counts_toward_top_of_all: true }, "admin");
    await db().from("organizations").update({ top_board_opt_out: true, updated_at: new Date().toISOString() }).eq("id", B.id);
    const bGone = await eventually(async () => {
      const p = await platform();
      return !p.some((l) => l.name === bName) && p.some((l) => l.name === `Qs1 ${tag}`);
    }, 8000);
    check(bGone, "an organisation that opted out is not on the platform board");
    const bOrg = await eventually(async () => {
      const o = await orgTop(B.slug);
      return o?.topBoard?.lines.some((l) => l.name === bName) ? o : null;
    }, 20000);
    check(Boolean(bOrg), "…but its own board still is");
    plat = await platform();

    section("6. joining by mode");
    const { data: jt } = await db().from("tournaments").insert({ name: `E2E Join ${tag}`, slug: `e2e-lg-j-${tag}`, organization_id: A.id, status: "active", is_demo: true }).select("id").single();
    const TJ = (jt as { id: string }).id;
    const { data: jteam } = await db().from("teams").insert({ tournament_id: TJ, team_name: `Joiners ${tag}` }).select("id").single();
    const P5 = await profile("Joiner5", A.id);
    const P7 = await profile("Stranger7", null);
    const P8 = await profile("Asker8", A.id);
    // An account linked the way Phase 1 links a code: it holds the row (proof "code") and speaks for
    // the profile (player_profiles.auth_user_id). ownsProfile false: the row was linked without its
    // profile (the proof did not reach it), so the account is not that player in leagues.
    const user = async (key: string, profileId: string | null, ownsProfile = true) => {
      const u = await appUser(`e2e.lg.u${key}.${tag}@example.com`);
      created.users.push(u.userId);
      if (profileId) {
        const { data: pl } = await db().from("players").insert({ tournament_id: TJ, team_id: (jteam as { id: string }).id, full_name: `U${key}`, player_order: 1, player_profile_id: profileId }).select("id").single();
        const row = (pl as { id: string }).id;
        await db().from("player_claims").insert({ user_id: u.userId, player_id: row, via_player_id: row, proof: "code" });
        if (ownsProfile) await db().from("player_profiles").update({ auth_user_id: u.userId }).eq("id", profileId);
      }
      return { who: bearer(u.token), userId: u.userId };
    };
    const U0 = await user("0", null);
    const U5 = await user("5", P5);
    const U7 = await user("7", P7);
    const U8 = await user("8", P8);
    const P9b = await profile("RowOnly9", A.id);
    const U9 = await user("9", P9b, false);
    const join = (slug: string, who: Who, body: Record<string, unknown> = {}) => http("POST", `/api/mobile/v1/leagues/${slug}/join`, who, body);

    let j = await join(LA.slug, U0.who);
    check(j.status === 409 && (j.json as { code: string }).code === "link_profile" && /link your player profile/i.test(j.text), "no linked player profile: a clear 'link your player profile first'", j.text);
    j = await join(LA.slug, U9.who);
    check(j.status === 409 && (j.json as { code: string }).code === "link_profile", "a claimed row whose profile the account does not speak for is not enough (profileForUser reads auth_user_id only)", j.text);
    j = await join(LA.slug, {});
    check(j.status === 401, "signed out: 401", j.status);
    j = await join(LA.slug, U5.who);
    check(j.status === 200 && (j.json as { outcome: string }).outcome === "joined", "open league: joined at once", j.text);
    const { data: m5 } = await db().from("league_members").select("status, division_id, auth_user_id").eq("league_id", LA.id).eq("player_profile_id", P5).single();
    check((m5 as { status: string }).status === "active" && (m5 as { division_id: string }).division_id === D1, "…active, in the league's only division", m5);
    j = await join(LA.slug, U5.who);
    check(j.status === 409 && (j.json as { code: string }).code === "already_member", "joining twice: already a member", j.text);
    j = await join(LA.slug, U7.who);
    const { data: op7 } = await db().from("organization_players").select("source, approval_status").eq("organization_id", A.id).eq("player_profile_id", P7).maybeSingle();
    const { data: op7n } = await db().from("organization_players").select("typed_name").eq("organization_id", A.id).eq("player_profile_id", P7).maybeSingle();
    check(
      j.status === 200 && (op7 as { source: string } | null)?.source === "matched" && (op7n as { typed_name: string | null } | null)?.typed_name === `Stranger7 ${tag}`,
      "a player new to the organisation becomes one of its players as 'matched' under their public name: joining vouches for nothing",
      op7,
    );
    const { data: op5 } = await db().from("organization_players").select("source").eq("organization_id", A.id).eq("player_profile_id", P5).single();
    check((op5 as { source: string }).source === "admin", "…an existing organisation player's row is left as it was", op5);

    await updateLeague(LA.id, { join_modes: ["approval"] }, "admin");
    j = await join(LA.slug, U8.who);
    const { data: m8 } = await db().from("league_members").select("id, status").eq("league_id", LA.id).eq("player_profile_id", P8).single();
    check(j.status === 200 && (j.json as { outcome: string }).outcome === "pending_approval" && (m8 as { status: string }).status === "pending", "approval: the request waits", j.text);
    const bApprove = await action("decideMemberAction", { member_id: (m8 as { id: string }).id, decision: "approve" }, bAdmin);
    const { data: m8b } = await db().from("league_members").select("status").eq("id", (m8 as { id: string }).id).single();
    check(!actionOk(bApprove) && (m8b as { status: string }).status === "pending", "another organisation's admin cannot approve it", bApprove.text.slice(0, 200));
    const aApprove = await action("decideMemberAction", { member_id: (m8 as { id: string }).id, decision: "approve" }, aAdmin);
    const { data: m8c } = await db().from("league_members").select("status").eq("id", (m8 as { id: string }).id).single();
    check(actionOk(aApprove) && (m8c as { status: string }).status === "active", "the organiser approves it", aApprove.text.slice(0, 200));

    const LC = await createLeague({ organizationId: A.id, name: `E2E Invite ${tag}`, kind: "nights", sport: "padel", actorRole: "admin" });
    await updateLeague(LC.id, { status: "active", join_modes: ["invite_code"] }, "admin");
    const code = await resetInviteCode(LC.id, "admin");
    j = await join(LC.slug, U5.who);
    check(j.status === 403 && (j.json as { code: string }).code === "invite_code_required", "invite code: none given → refused", j.text);
    j = await join(LC.slug, U5.who, { code: "ABCD-EFGH" });
    check(j.status === 403 && (j.json as { code: string }).code === "invite_code_wrong", "…a wrong code → refused", j.text);
    j = await join(LC.slug, U5.who, { code: code.toLowerCase() });
    check(j.status === 200 && (j.json as { outcome: string }).outcome === "joined", "…the right code (any case) → joined", j.text);
    const { data: lcRow } = await db().from("leagues").select("invite_code_hash").eq("id", LC.id).single();
    const { data: auditRows } = await db().from("audit_logs").select("new_value, old_value").eq("organization_id", A.id).limit(2000);
    const plain = code.replace("-", "");
    check(/^[0-9a-f]{64}$/.test((lcRow as { invite_code_hash: string }).invite_code_hash) && !JSON.stringify(auditRows).includes(plain) && !JSON.stringify(auditRows).includes(code), "the code is stored only as a hash and never in the audit log");
    const leaguePage = await http("GET", `/api/mobile/v1/leagues/${LC.slug}`);
    check(leaguePage.status === 200 && !leaguePage.text.includes("invite_code_hash") && !leaguePage.text.includes((lcRow as { invite_code_hash: string }).invite_code_hash), "the public league page never carries the hash");

    const LP = await createLeague({ organizationId: A.id, name: `E2E Paid ${tag}`, kind: "nights", sport: "padel", actorRole: "admin" });
    await updateLeague(LP.id, { status: "active", join_modes: ["paid"], fee: { membership: { amount: 500, currency: "EGP" }, per_night: null } }, "admin");
    j = await join(LP.slug, U5.who);
    const { data: mp } = await db().from("league_members").select("status, pay_at_venue").eq("league_id", LP.id).eq("player_profile_id", P5).single();
    check(j.status === 200 && (j.json as { payAtVenue: boolean }).payAtVenue === true && (mp as { status: string }).status === "active" && (mp as { pay_at_venue: boolean }).pay_at_venue, "paid league outside Move Beyond: joins, pays at the venue", j.text);
    const pp = (await http("GET", `/api/mobile/v1/leagues/${LP.slug}`)).json as { league: { fee: { membership: string; payAtVenue: boolean } } };
    check(pp.league.fee.payAtVenue && pp.league.fee.membership === "500 EGP", "…and the league page says so", pp.league.fee);
    const mine = await http("GET", "/api/mobile/v1/me/leagues", U5.who);
    const myL = (mine.json as { profileLinked: boolean; leagues: { slug: string; status: string }[] }).leagues;
    check(mine.status === 200 && myL.some((l) => l.slug === LA.slug) && myL.some((l) => l.slug === LP.slug) && myL.some((l) => l.slug === LC.slug), "GET /me/leagues lists the account's leagues", myL);
    const mine0 = await http("GET", "/api/mobile/v1/me/leagues", U0.who);
    check((mine0.json as { profileLinked: boolean }).profileLinked === false, "…and says when no profile is linked");

    section("7. app surfaces: league nights open in the app, other sessions stay hidden");
    const bundle = await http("GET", `/api/mobile/v1/t/${night.slug}/bundle`);
    check(bundle.status === 200, "a league night's bundle loads", bundle.status);
    const live = await http("GET", `/api/mobile/v1/t/${night.slug}/live`);
    check(live.status === 200 && ((live.json as { matches: unknown[] }).matches.length ?? 0) >= 2, "…and its live feed", live.status);
    const plainSession = await createFriendlySession({ name: `E2E Plain ${tag}`, seasonId: null, startsAt: null, durationMinutes: null, courtCount: 1, pairingMode: "americano", rankingModel: "win_points", setsToWinMatch: 1, gamesToWinSet: 6, maxPlayers: null, registrationDeadline: null, organizationId: A.id, actorRole: "admin" });
    const { data: pst } = await db().from("tournaments").select("slug").eq("id", (plainSession as { tournament_id: string }).tournament_id).single();
    const plainBundle = await http("GET", `/api/mobile/v1/t/${(pst as { slug: string }).slug}/bundle`);
    check(plainBundle.status === 404, "a stand-alone session is still not in the app", plainBundle.status);
    const ref = await http("GET", "/api/mobile/v1/referee/tournaments", aReferee);
    const refIds = ((ref.json as { tournaments: { id: string }[] }).tournaments ?? []).map((t) => t.id);
    check(refIds.includes(NT) && !refIds.includes((plainSession as { tournament_id: string }).tournament_id), "the referee list has the league night, not the stand-alone session", refIds.length);

    section("8. another organisation's admin");
    const beforeLA = await pointsOf({ league: LA.id });
    const page = await http("GET", `/admin/leagues/${LA.id}`, bAdmin);
    check(page.status === 404 && !page.text.includes(`E2E Nights ${tag}`), "cannot open the league's admin page", page.status);
    const list = await http("GET", "/admin/leagues", bAdmin);
    check(list.status === 200 && !list.text.includes(`E2E Nights ${tag}`) && list.text.includes(`E2E B Season ${tag}`), "its league list shows only its own leagues");
    const rename = await action("saveLeagueSettings", { league_id: LA.id, name: "Hijacked", status: "archived", sport: "padel", timezone: "UTC" }, bAdmin);
    const { data: laNow } = await db().from("leagues").select("name, status").eq("id", LA.id).single();
    check(!actionOk(rename) && (laNow as { name: string }).name === `E2E Nights ${tag}`, "cannot edit it", rename.text.slice(0, 200));
    const pr = await action("savePointsRules", { league_id: LA.id, win: "50" }, bAdmin);
    check(!actionOk(pr), "cannot change its points rules");
    const recalc = await action("recalculateLeagueAction", { league_id: LA.id }, bAdmin);
    check(!actionOk(recalc), "cannot recalculate it");
    const { data: m5row } = await db().from("league_members").select("id").eq("league_id", LA.id).eq("player_profile_id", P5).single();
    const rm = await action("decideMemberAction", { member_id: (m5row as { id: string }).id, decision: "remove" }, bAdmin);
    const { data: m5now } = await db().from("league_members").select("status").eq("id", (m5row as { id: string }).id).single();
    check(!actionOk(rm) && (m5now as { status: string }).status === "active", "cannot remove its members", rm.text.slice(0, 200));
    const add = await action("addMemberAction", { league_id: LB.id, profile_id: P[0], division_id: BD }, bAdmin);
    const { count: stolen } = await db().from("league_members").select("id", { count: "exact", head: true }).eq("league_id", LB.id).eq("player_profile_id", P[0]);
    check(!actionOk(add) && stolen === 0, "cannot add one of our players to its own league", add.text.slice(0, 200));
    const moveDiv = await action("setMemberDivisionAction", { member_id: (m5row as { id: string }).id, division_id: BD }, bAdmin);
    check(!actionOk(moveDiv), "cannot move our member into its division");
    const { data: tbRow } = await db().from("tournaments").insert({ name: `E2E B Cup ${tag}`, slug: `e2e-lg-b-${tag}`, organization_id: B.id, status: "active", is_demo: true }).select("id").single();
    const TB = (tbRow as { id: string }).id;
    const steal = await action("setCountsTowardAction", { tournament_id: TB, division_id: D1 }, bAdmin);
    const { data: tbNow } = await db().from("tournaments").select("counts_toward").eq("id", TB).single();
    check(!actionOk(steal) && (tbNow as { counts_toward: string | null }).counts_toward === null, "cannot count its tournament toward our league", steal.text.slice(0, 200));
    const reverse = await action("setCountsTowardAction", { tournament_id: TA, division_id: BD }, bAdmin);
    const { data: taNow } = await db().from("tournaments").select("counts_toward").eq("id", TA).single();
    check(!actionOk(reverse) && (taNow as { counts_toward: string }).counts_toward === D1, "cannot count our tournament toward its league", reverse.text.slice(0, 200));
    const { error: dbRefuse } = await db().from("tournaments").update({ counts_toward: D1 }).eq("id", TB);
    check(Boolean(dbRefuse) && /own organisation/.test(dbRefuse?.message ?? ""), "the database refuses it too, whatever writes the row", dbRefuse?.message);
    const night2 = await action("createNightAction", { division_id: D1, date: "2026-12-24" }, bAdmin);
    const { count: xmas } = await db().from("league_fixtures").select("id", { count: "exact", head: true }).eq("league_id", LA.id).eq("date", "2026-12-24");
    check(!actionOk(night2) && xmas === 0, "cannot add a night to our league", night2.text.slice(0, 200));
    const afterLA = await pointsOf({ league: LA.id });
    check(afterLA.length === beforeLA.length && sum(afterLA) === sum(beforeLA), "our league's points are untouched");
    const ownSave = await action("saveLeagueSettings", { league_id: LA.id, name: `E2E Nights ${tag}`, status: "active", sport: "padel", timezone: "Africa/Cairo", join_modes: "approval", counts_toward_top_of_all: "on" }, aAdmin);
    check(actionOk(ownSave), "(our own admin can save the same form)", ownSave.text.slice(0, 200));
    const ownPage = await http("GET", `/admin/leagues/${LA.id}`, aAdmin);
    const ownSeason = await http("GET", `/admin/leagues/${LS.id}?period=3&month=2026-11`, aAdmin);
    check(
      ownPage.status === 200 && /Points rules/.test(ownPage.text) && /Nights/.test(ownPage.text) && /Invite code/.test(ownPage.text) && ownSeason.status === 200 && /Season fixtures/.test(ownSeason.text) && ownSeason.text.includes(`Typed Name ${tag}`) && !ownSeason.text.includes("Secret Realname"),
      "(our own admin's league pages render: settings, points, nights, fixtures; masked names stay masked)",
      { a: ownPage.status, s: ownSeason.status },
    );

    section("9. no private fields on boards and league pages");
    const pages = [
      await http("GET", `/api/mobile/v1/leagues/${LS.slug}?period=12&month=2026-11`),
      await http("GET", `/api/mobile/v1/leagues/${LA.slug}`),
      await http("GET", "/api/mobile/v1/leagues/top?month=2026-11"),
      await http("GET", `/api/mobile/v1/orgs/${A.slug}`),
    ];
    const blob = pages.map((p) => p.text).join("\n");
    const leaks = [...created.profiles, `secret.${tag}@example.com`, "+2010", "mobile", "email", "phone", "access_code", "photo", "portrait", "player_profile_id", "Secret Realname", "top_board"].filter((x) => blob.includes(x));
    check(pages.every((p) => p.status === 200) && leaks.length === 0, "names and numbers only: no profile id, phone, email, photo or masked real name", leaks);
    const lsPage = pages[0].json as { board: { name: string }[]; fixtures: { home: string; away: string }[] };
    check(lsPage.board.some((l) => l.name === `Typed Name ${tag}`) && lsPage.fixtures.some((f) => f.home.includes(`Typed Name ${tag}`) || f.away.includes(`Typed Name ${tag}`)), "a player the organisation only matched shows under the name typed on its form", lsPage.board.map((l) => l.name));
    const lines = (pages[0].json as { board: Record<string, unknown>[] }).board;
    check(lines.every((l) => JSON.stringify(Object.keys(l).sort()) === JSON.stringify(["gameDiff", "losses", "name", "played", "points", "rank", "wins"])), "a board line has exactly the public fields", Object.keys(lines[0] ?? {}));
  } finally {
    const orgs = created.orgs;
    if (orgs.length) {
      await db().from("tournaments").delete().in("organization_id", orgs);
      await db().from("leagues").delete().in("organization_id", orgs);
      await db().from("audit_logs").delete().in("organization_id", orgs);
      await db().from("organization_codes").delete().in("organization_id", orgs);
    }
    if (created.users.length) await db().from("player_claims").delete().in("user_id", created.users);
    if (created.profiles.length) {
      await db().from("player_score_ledger").delete().in("player_profile_id", created.profiles);
      await db().from("player_profiles").delete().in("id", created.profiles);
    }
    if (orgs.length) {
      await db().from("organization_members").delete().in("organization_id", orgs);
      await db().from("organizations").delete().in("id", orgs);
    }
    await db().from("request_counters").delete().like("bucket_key", "league-code:%");
    const { count } = orgs.length ? await db().from("leagues").select("id", { count: "exact", head: true }).in("organization_id", orgs) : { count: 0 };
    check((count ?? 0) === 0, "cleanup: every league, tournament and player made here is gone");
  }
  finish("leagues");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
