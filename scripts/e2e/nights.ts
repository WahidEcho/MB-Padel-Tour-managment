/**
 * Americano / Mexicano nights (plan Phase 8), end to end on the stand-in.
 *
 *   1. A league night from the template takes the league's sport (tennis here).
 *   2. "Confirm players and publish table": an unticked player is withdrawn; the
 *      table is generated with its order of play per court (match order: rounds,
 *      then courts) and "about" times (each match starts when its court and its
 *      players are free) stored in matches.scheduled_time.
 *   3. Alerts (PUSH_DRY_RUN): one per match, to its players only, through their
 *      own accounts — the one linking rule (src/lib/players/link.ts): the profile's
 *      own account (player_profiles.auth_user_id) when the organisation vouches for
 *      the profile, or when that same account joined the league itself; never an
 *      account named only by league_members.auth_user_id (H1). Derived claims hang
 *      on the code that gave the account its profile: resetting it undoes them.
 *      A phone with "scheduled" off, an unlinked phone and a follower of the night
 *      get nothing.
 *   4. Re-estimates: a match that finishes early pulls its court's next match
 *      forward (through the scoring hooks); one that runs long or finishes late
 *      pushes it back.
 *   5. Final results on a night: the organiser (session page action) and a
 *      referee (events API); refused when the session scores point by point only.
 *   6. The table on the public session page, the app's bundle and league page,
 *      and the TV; no private fields.
 *   7. The night in the live courts hero while a match is on (and its showcase
 *      is on); a stand-alone session never.
 *   8. Another organisation's admin cannot publish the table or enter results;
 *      a player of another organisation cannot be confirmed; no publishing once
 *      the night has started.
 *
 * Stand-in only; creates and deletes its own data.
 *
 *   LOCALDB_PORT=54331 npm run localdb                       # terminal 1
 *   npm run build                                            # no `next dev` running
 *   (set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3087 PUSH_DRY_RUN=1 npx next start -p 3087)
 *   npm run e2e:nights
 */
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { db } from "../../src/lib/supabase";
import { createFriendlySession } from "../../src/lib/friendly/ops";
import { reestimateSessionTable } from "../../src/lib/friendly/nights";
import { initialScoreState, type ScoreState } from "../../src/lib/scoring/engine";
import { stateFromFinalScore } from "../../src/lib/scoring/finalScore";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { generateEventCode, hashEventCode } from "../../src/lib/orgs/codes";
import { storedNightTemplate, nightTemplate, addDays } from "../../src/lib/leagues/settings";
import { addMember, createLeague, createNight, updateLeague } from "../../src/lib/leagues/ops";
import { todayIn } from "../../src/lib/leagues/server";
import type { Match, Tournament } from "../../src/lib/types";
import { staffToken } from "./lib/session";
import { appUser, assertStandIn, BASE_URL, bearer, check, cookie, eventually, finish, http, section, sleep, type Who } from "./lib/fixtures";

assertStandIn("nights.ts");

const MIN = 60_000;
const DEVICE = `e2e-nt-${randomUUID().slice(0, 8)}`;

/* ---------------- server actions, called the way the browser does ---------------- */

interface ManifestEntry {
  filename: string;
  exportedName: string;
}
const manifest = JSON.parse(readFileSync(join(process.cwd(), ".next/server/server-reference-manifest.json"), "utf8")) as { node: Record<string, ManifestEntry> };
const ACTIONS = "src/app/admin/friendly-sessions/actions.ts";

function actionId(name: string): string {
  const sameFile = (f: string) => f === ACTIONS || f.endsWith(`/${ACTIONS}`) || `src/${f}` === ACTIONS;
  const hit = Object.entries(manifest.node).find(([, e]) => sameFile(e.filename) && e.exportedName === name);
  if (!hit) throw new Error(`no server action ${name} in the build manifest (rebuild?)`);
  return hit[0];
}

/** A form action (one FormData argument). */
async function formAction(name: string, form: Record<string, string | string[]>, who: Who) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) fd.append(`_1_${k}`, x);
  // publishNightTableAction is a (state, form) action: its refusals come back as { ok: false, message }.
  fd.set("0", JSON.stringify(STATE_ACTIONS.has(name) ? [null, "$K1"] : ["$K1"]));
  const res = await fetch(`${BASE_URL}/admin/friendly-sessions`, { method: "POST", headers: { "Next-Action": actionId(name), Accept: "text/x-component", Origin: BASE_URL, ...who }, body: fd, redirect: "manual" });
  return { status: res.status, text: await res.text() };
}

/** An action called with plain arguments (the result dialog's). */
async function argsAction(name: string, args: unknown[], who: Who) {
  const res = await fetch(`${BASE_URL}/admin/friendly-sessions`, {
    method: "POST",
    headers: { "Next-Action": actionId(name), Accept: "text/x-component", "Content-Type": "text/plain;charset=UTF-8", Origin: BASE_URL, ...who },
    body: JSON.stringify(args),
    redirect: "manual",
  });
  return { status: res.status, text: await res.text() };
}
const STATE_ACTIONS = new Set(["publishNightTableAction"]);
/** Went through: no error, and not a (state, form) action answering { ok: false }. */
const actionOk = (r: { status: number; text: string }) => (r.status === 200 || r.status === 303) && !/"digest"|Not found|Not allowed|"ok":false/.test(r.text);

/* ---------------- scoring through the events route ---------------- */

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
  return { match, tournament, rules: scoringConfigForMatch(tournament, match), n: snap?.last_event_number ?? 0, state: snap?.snapshot_json?.teamA ? snap.snapshot_json : null };
}

const send = (matchId: string, who: Who, events: unknown[]) => http("POST", `/api/matches/${matchId}/events`, who, { deviceId: DEVICE, events });

async function start(matchId: string, who: Who) {
  const c = await ctx(matchId);
  const s = initialScoreState("A");
  return send(matchId, who, [ev(c.n + 1, "MATCH_STARTED", c.state, s, { payload: { first_server: "A" } })]);
}

async function enterResult(matchId: string, who: Who, sets: { a: number; b: number }[]) {
  const c = await ctx(matchId);
  const built = stateFromFinalScore(c.rules, sets);
  if (!built.ok) throw new Error(`result fixture: ${JSON.stringify(built.problems)}`);
  const winner = built.state.winner === "A" ? c.match.team_a_id : c.match.team_b_id;
  return send(matchId, who, [ev(c.n + 1, "RESULT_ENTERED", c.state, built.state, { team_id: winner, payload: { sets } })]);
}

/* ---------------- rows ---------------- */

interface MRow {
  id: string;
  court_id: string;
  match_order: number;
  round_name: string;
  status: string;
  scheduled_time: string | null;
  started_at: string | null;
  ended_at: string | null;
  result_source: string | null;
}
async function matchesOf(tournamentId: string): Promise<MRow[]> {
  const { data } = await db().from("matches").select("id, court_id, match_order, round_name, status, scheduled_time, started_at, ended_at, result_source").eq("tournament_id", tournamentId).order("match_order");
  return (data ?? []) as MRow[];
}
const round = (m: MRow) => Number(m.round_name.replace(/^R/, ""));
const at = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
const near = (a: number, b: number, ms = 5000) => Math.abs(a - b) <= ms;

async function sessionOf(tournamentId: string) {
  const { data } = await db().from("friendly_sessions").select("id, slug, starts_at, scoring_mode").eq("tournament_id", tournamentId).single();
  return data as { id: string; slug: string; starts_at: string; scoring_mode: string };
}

async function main() {
  const tag = randomUUID().slice(0, 6);
  const created = { orgs: [] as string[], profiles: [] as string[], users: [] as string[], devices: [] as string[] };

  try {
    section("0. two organisations, their admins and referee, players, accounts and phones");
    const org = async (key: string) => {
      const { data, error } = await db().from("organizations").insert({ slug: `e2e-nt-${key}-${tag}`, name: `E2E Nights Org ${key.toUpperCase()} ${tag}`, status: "approved" }).select("id, slug").single();
      if (error) throw new Error(error.message);
      created.orgs.push((data as { id: string }).id);
      return data as { id: string; slug: string };
    };
    const A = await org("a");
    const B = await org("b");
    const admin = async (o: { id: string }, key: string) => {
      const u = await appUser(`e2e.nt.${key}.${tag}@example.com`);
      created.users.push(u.userId);
      await db().from("organization_members").insert({ organization_id: o.id, auth_user_id: u.userId, invited_email: `e2e.nt.${key}.${tag}@example.com`, role: "admin", status: "active" });
      return cookie(staffToken({ kind: "member", userId: u.userId, orgId: o.id, role: "admin" }));
    };
    const aAdmin = await admin(A, "a");
    const bAdmin = await admin(B, "b");
    const { data: codeRow } = await db().from("organization_codes").insert({ organization_id: A.id, role: "referee", code_hash: hashEventCode(generateEventCode()), label: "e2e" }).select("id").single();
    const aReferee = bearer(staffToken({ kind: "code", codeId: (codeRow as { id: string }).id, orgId: A.id, role: "referee" }));

    const profile = async (name: string, orgId: string, extra: Record<string, unknown> = {}) => {
      const { data, error } = await db().from("player_profiles").insert({ public_name: `${name} ${tag}`, approval_status: "approved", ...extra }).select("id").single();
      if (error) throw new Error(error.message);
      const id = (data as { id: string }).id;
      created.profiles.push(id);
      await db().from("organization_players").insert({ organization_id: orgId, player_profile_id: id, source: "admin", approval_status: "approved" });
      return id;
    };
    const P = await Promise.all(["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9"].map((n) => profile(n, A.id)));
    const PB = await profile("Nb1", B.id);

    // Accounts: U1 is P1's own (profile.auth_user_id); U2 became P2's own by claiming P2's code
    // in another event (a code link: profile + code claim); U3 is P3's own and joined the league
    // itself, while org A only matched P3 (org B added them); U5 is P5's own with "scheduled"
    // alerts off; U4 is nobody's, yet names P4 on a stale league membership (H1).
    const user = async (key: string) => {
      const u = await appUser(`e2e.nt.${key}.${tag}@example.com`);
      created.users.push(u.userId);
      return u;
    };
    const [U1, U2, U3, U4, U5] = await Promise.all(["u1", "u2", "u3", "u4", "u5"].map(user));
    await db().from("player_profiles").update({ auth_user_id: U1.userId }).eq("id", P[0]);
    await db().from("player_profiles").update({ auth_user_id: U5.userId }).eq("id", P[4]);
    const { data: otherT } = await db().from("tournaments").insert({ name: `E2E NT Other ${tag}`, slug: `e2e-nt-other-${tag}`, organization_id: A.id, status: "completed", is_demo: true }).select("id").single();
    const { data: otherTeam } = await db().from("teams").insert({ tournament_id: (otherT as { id: string }).id, team_name: `Other ${tag}` }).select("id").single();
    const { data: otherRow } = await db().from("players").insert({ tournament_id: (otherT as { id: string }).id, team_id: (otherTeam as { id: string }).id, full_name: `N2 ${tag}`, player_order: 1, player_profile_id: P[1] }).select("id").single();
    const P2Row = (otherRow as { id: string }).id;
    await db().from("player_claims").insert({ user_id: U2.userId, player_id: P2Row, via_player_id: P2Row, proof: "code" });
    await db().from("player_profiles").update({ auth_user_id: U2.userId }).eq("id", P[1]);
    // P3: org B's player that org A only matched (typed name); U3 speaks for the profile.
    await db().from("organization_players").update({ source: "matched", typed_name: `N3 typed ${tag}` }).eq("organization_id", A.id).eq("player_profile_id", P[2]);
    await db().from("organization_players").insert({ organization_id: B.id, player_profile_id: P[2], source: "admin", approval_status: "approved" });
    await db().from("player_profiles").update({ auth_user_id: U3.userId }).eq("id", P[2]);

    const device = async (name: string, userId: string | null, prefs: Record<string, unknown> = {}) => {
      const installationId = `e2e-nt-${tag}-${name}`;
      const { data, error } = await db()
        .from("push_devices")
        .insert({ installation_id: installationId, platform: "ios", user_id: userId, expo_push_token: `ExponentPushToken[e2ent${tag}${name}]`.replace(/[^A-Za-z0-9_[\]-]/g, ""), prefs })
        .select("id")
        .single();
      if (error) throw new Error(`device: ${error.message}`);
      created.devices.push((data as { id: string }).id);
      return { id: (data as { id: string }).id, installationId };
    };
    const D1 = await device("u1", U1.userId);
    const D2 = await device("u2", U2.userId);
    const D3 = await device("u3", U3.userId);
    const D4 = await device("u4", U4.userId);
    const D5 = await device("u5", U5.userId, { scheduled: false });
    const D6 = await device("fan", null);
    check(true, "orgs, admins, referee, nine players, five accounts and six phones ready");

    section("1. a night from the league's template takes the league's sport");
    const L = await createLeague({ organizationId: A.id, name: `E2E Tennis Nights ${tag}`, kind: "nights", sport: "tennis", actorRole: "admin" });
    await updateLeague(L.id, { status: "active", night_template: storedNightTemplate({ ...nightTemplate({}), courts: 2, gamesToWinSet: 2, setsToWinMatch: 1, pairingMode: "americano", scoringMode: "either" }) }, "admin");
    const { data: dRows } = await db().from("league_divisions").select("id").eq("league_id", L.id);
    const DIV = (dRows as { id: string }[])[0].id;
    for (const p of P) await addMember(L.id, p, DIV, "admin");
    await db().from("league_members").update({ auth_user_id: U3.userId }).eq("league_id", L.id).eq("player_profile_id", P[2]);
    // H1: an account that once joined as P4 (say with a code it held for a moment) and no longer speaks for P4.
    await db().from("league_members").update({ auth_user_id: U4.userId }).eq("league_id", L.id).eq("player_profile_id", P[3]);
    const today = todayIn("Africa/Cairo");
    const night = await createNight(DIV, today, "admin");
    const { data: ns } = await db().from("friendly_sessions").select("tournament_id, scoring_mode").eq("id", night.sessionId).single();
    const T1 = (ns as { tournament_id: string }).tournament_id;
    const { data: t1 } = await db().from("tournaments").select("sport, name").eq("id", T1).single();
    check((t1 as { sport: string }).sport === "tennis", "the night's sport is the league's (tennis), not padel", t1);
    check((ns as { scoring_mode: string }).scoring_mode === "either", "the night scores either way (Phase 2 final results allowed)", ns);
    // The night starts in two hours, so the estimates start from its start time.
    const t0 = Math.ceil((Date.now() + 2 * 3600_000) / MIN) * MIN;
    await db().from("friendly_sessions").update({ starts_at: new Date(t0).toISOString() }).eq("id", night.sessionId);

    section("2. confirm players and publish the table: order of play per court, \"about\" times");
    const eventsBefore = await db().from("notification_events").select("id", { count: "exact", head: true }).eq("tournament_id", T1);
    // Org B's admin first: refused, nothing changes.
    const xPublish = await formAction("publishNightTableAction", { session_id: night.sessionId, confirm_players: "1", playing: P.slice(0, 8), match_minutes: "20", changeover_minutes: "5" }, bAdmin);
    const { count: xMatches } = await db().from("matches").select("id", { count: "exact", head: true }).eq("tournament_id", T1);
    check(!actionOk(xPublish) && xMatches === 0, "another organisation's admin cannot publish the table (nothing generated)", xPublish.text.slice(0, 200));
    const foreign = await formAction("publishNightTableAction", { session_id: night.sessionId, confirm_players: "1", playing: [...P.slice(0, 7), PB], match_minutes: "20", changeover_minutes: "5" }, aAdmin);
    check(!actionOk(foreign), "a player of another organisation cannot be confirmed", foreign.text.slice(0, 200));

    const pub = await formAction("publishNightTableAction", { session_id: night.sessionId, confirm_players: "1", playing: P.slice(0, 8), match_minutes: "20", changeover_minutes: "5" }, aAdmin);
    check(actionOk(pub), "our admin publishes the table", pub.text.slice(0, 300));
    const { data: n9 } = await db().from("friendly_entries").select("approval").eq("session_id", night.sessionId).eq("player_profile_id", P[8]).single();
    check((n9 as { approval: string }).approval === "withdrawn", "the unticked player is withdrawn from tonight");
    const { data: tFmt } = await db().from("tournaments").select("format_config").eq("id", T1).single();
    const publishedAt = (tFmt as { format_config: { nightTable?: { publishedAt: string } } }).format_config.nightTable?.publishedAt;
    check(Boolean(publishedAt), "the table is marked published", tFmt);
    const { data: sess1 } = await db().from("friendly_sessions").select("expected_match_minutes, turnover_minutes").eq("id", night.sessionId).single();
    check((sess1 as { expected_match_minutes: number }).expected_match_minutes === 20 && (sess1 as { turnover_minutes: number }).turnover_minutes === 5, "minutes per match and changeover are saved");

    const m1 = await matchesOf(T1);
    const { data: courts } = await db().from("courts").select("id, court_order").eq("tournament_id", T1).order("court_order");
    const courtIds = (courts as { id: string }[]).map((c) => c.id);
    const rounds = Math.max(...m1.map(round));
    check(m1.length === rounds * 2 && rounds >= 3, "eight players on two courts: two matches a round", { matches: m1.length, rounds });
    check(m1.every((m) => at(m.scheduled_time) === t0 + (round(m) - 1) * 25 * MIN), "each match's estimate is the night's start + 25 minutes a round (20 to play, 5 to change over)", m1.map((m) => [m.round_name, m.scheduled_time]));
    const orderOk = m1.every((m, i) => i === 0 || round(m1[i - 1]) < round(m) || (round(m1[i - 1]) === round(m) && courtIds.indexOf(m1[i - 1].court_id) < courtIds.indexOf(m.court_id)));
    check(orderOk, "match order is the order of play: rounds in order, courts in order within a round");
    for (const c of courtIds) {
      const list = m1.filter((m) => m.court_id === c);
      check(list.every((m, i) => i === 0 || at(m.scheduled_time) - at(list[i - 1].scheduled_time) >= 25 * MIN), `per court (${courtIds.indexOf(c) + 1}): times rise along its order of play`, list.map((m) => m.scheduled_time));
    }

    section("3. alerts: the players only, through their own accounts (dry run)");
    const { data: evRows } = await db().from("notification_events").select("id, kind, match_id, payload").eq("tournament_id", T1).eq("kind", "match_scheduled");
    const events = (evRows ?? []) as { id: string; match_id: string; payload: { targets: unknown[]; self?: { playerIds: string[]; title: string }; title: string } }[];
    check(events.length === m1.length && (eventsBefore.count ?? 0) === 0, "one 'your court and time' alert per match", events.length);
    check(events.every((e) => e.payload.targets.length === 0 && e.payload.self?.playerIds.length === 4), "…targeting nobody but the match's four players (self wording)", events[0]?.payload);
    check(events.every((e) => /^Your table: Court \d, about \d\d:\d\d$/.test(e.payload.title)), "…saying the court and the estimated time", events[0]?.payload.title);
    // Linked rows: P1 (own account), P2 (a claim elsewhere), P3 (joined the league), P5 (own account); not P4, P6–P8.
    const { data: nightRows } = await db().from("players").select("id, player_profile_id").eq("tournament_id", T1);
    const rowsOf = (p: string) => ((nightRows ?? []) as { id: string; player_profile_id: string }[]).filter((r) => r.player_profile_id === p).map((r) => r.id);
    const { data: claimRows } = await db().from("player_claims").select("user_id, player_id, via_player_id").in("player_id", ((nightRows ?? []) as { id: string }[]).map((r) => r.id));
    const claims = (claimRows ?? []) as { user_id: string; player_id: string; via_player_id: string | null }[];
    const claimedBy = (p: string) => new Set(claims.filter((c) => rowsOf(p).includes(c.player_id)).map((c) => c.user_id));
    check(rowsOf(P[0]).length > 0 && [...claimedBy(P[0])].join() === U1.userId, "P1's rows tonight are linked to P1's own account");
    check([...claimedBy(P[1])].join() === U2.userId && claims.filter((c) => rowsOf(P[1]).includes(c.player_id)).every((c) => c.via_player_id === P2Row), "P2's rows to the account that claimed P2's code elsewhere, hung on that code (via_player_id)");
    check([...claimedBy(P[2])].join() === U3.userId, "P3's rows to P3's own account, which joined the league itself (org A only matched P3)");
    check([P[3], P[5], P[6], P[7]].every((p) => claimedBy(p).size === 0), "players without an account stay unlinked");
    check(claimedBy(P[3]).size === 0 && claims.every((c) => c.user_id !== U4.userId), "H1: a league membership naming an account (league_members.auth_user_id) links nothing on its own");
    const { data: parts } = await db().from("friendly_match_participants").select("match_id, team_a_player_one, team_a_player_two, team_b_player_one, team_b_player_two").eq("session_id", night.sessionId);
    const playsIn = (p: string) => ((parts ?? []) as Record<string, string>[]).filter((r) => [r.team_a_player_one, r.team_a_player_two, r.team_b_player_one, r.team_b_player_two].includes(p)).map((r) => r.match_id);
    const eventOf = new Map(events.map((e) => [e.match_id, e.id]));
    const deliveries = async () => {
      const { data } = await db().from("notification_deliveries").select("event_id, device_id, status").in("event_id", events.map((e) => e.id));
      return (data ?? []) as { event_id: string; device_id: string; status: string }[];
    };
    const expected = playsIn(P[0]).length + playsIn(P[1]).length + playsIn(P[2]).length;
    const got = await eventually(async () => {
      const d = await deliveries();
      return d.filter((x) => x.status === "sent").length >= expected ? d : null;
    }, 15_000);
    const del = got ?? (await deliveries());
    const to = (dev: { id: string }) => new Set(del.filter((x) => x.device_id === dev.id && x.status === "sent").map((x) => x.event_id));
    check(
      [[D1, P[0]], [D2, P[1]], [D3, P[2]]].every(([d, p]) => {
        const want = new Set(playsIn(p as string).map((m) => eventOf.get(m)));
        const have = to(d as { id: string });
        return want.size > 0 && want.size === have.size && [...want].every((x) => have.has(x as string));
      }),
      "each linked player's phone gets exactly the alerts of their own matches",
      { expected, sent: del.filter((x) => x.status === "sent").length },
    );
    check(to(D5).size === 0 && del.every((x) => x.device_id !== D5.id), "a phone with 'scheduled' alerts off gets nothing");
    check(del.every((x) => x.device_id !== D4.id), "an account linked to nobody here gets nothing");
    await db().from("follows").insert({ owner_kind: "install", owner_id: D6.installationId, target_kind: "tournament", target_key: T1, tournament_id: T1 });
    await http("POST", "/api/internal/notifications/drain", { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` }, {});
    check((await deliveries()).every((x) => x.device_id !== D6.id), "a follower of the night (not a player) gets nothing");
    {
      // H1: resetting the code that gave U2 its profile takes the night's derived rows with it.
      const { resetPlayerCode } = await import("../../src/lib/players/claims");
      await resetPlayerCode(P2Row);
      const { data: left } = await db().from("player_claims").select("player_id").eq("user_id", U2.userId);
      const { data: p2 } = await db().from("player_profiles").select("auth_user_id").eq("id", P[1]).single();
      check((left ?? []).length === 0 && (p2 as { auth_user_id: string | null }).auth_user_id === null, "resetting P2's code unlinks U2 from P2's night rows and from the profile", { left: left?.length, profile: (p2 as { auth_user_id: string | null }).auth_user_id });
      const { linkNightPlayers } = await import("../../src/lib/friendly/nights");
      await linkNightPlayers(T1, L.id);
      const { data: again } = await db().from("player_claims").select("player_id").eq("user_id", U2.userId);
      check((again ?? []).length === 0, "…and linking the night again does not bring them back", again?.length);
    }

    section("4. the table everywhere: public session page, app bundle and league page, TV");
    const s1 = await sessionOf(T1);
    const pubPage = await http("GET", `/f/${s1.slug}`);
    check(pubPage.status === 200 && pubPage.text.includes('data-testid="night-table"') && /Order of play/.test(pubPage.text) && /about \d\d:\d\d/.test(pubPage.text), "the public session page shows the order of play with 'about' times", pubPage.status);
    const bundle = await http("GET", `/api/mobile/v1/t/${night.slug}/bundle`);
    const bNight = (bundle.json as { tournament: { night?: { publishedAt: string | null; layout: string } } }).tournament.night;
    check(bundle.status === 200 && bNight?.publishedAt === publishedAt && bNight?.layout === "by_court", "the app's bundle carries the night (published, layout)", bNight);
    const live = await http("GET", `/api/mobile/v1/t/${night.slug}/live`);
    const liveMatches = (live.json as { matches: { scheduledTime: string | null }[] }).matches;
    check(live.status === 200 && liveMatches.length === m1.length && liveMatches.every((m) => m.scheduledTime), "…and its live feed every match with its estimate (the app builds the table from it)");
    const lp = await http("GET", `/api/mobile/v1/leagues/${L.slug}`);
    const lNight = (lp.json as { nights: { slug: string; publishedAt: string | null; table: { courts: { name: string; entries: { label: string; position: number }[] }[] } | null }[] }).nights.find((n) => n.slug === night.slug);
    check(
      lp.status === 200 && lNight?.publishedAt === publishedAt && lNight?.table?.courts.length === 2 && lNight.table.courts.every((c) => c.entries[0].position === 1 && /^about \d\d:\d\d$/.test(c.entries[0].label)),
      "the app's league page has tonight's table per court",
      lNight?.table?.courts.map((c) => c.entries.slice(0, 2)),
    );
    const leaks = [...created.profiles, "mobile", "email", "phone", "access_code", "player_profile_id"].filter((x) => JSON.stringify(lNight?.table ?? {}).includes(x));
    check(leaks.length === 0, "the table carries names and times only", leaks);
    const adminPage = await http("GET", `/admin/friendly-sessions/${night.sessionId}`, aAdmin);
    check(
      adminPage.status === 200 && adminPage.text.includes('data-testid="publish-night-table"') && /Publish again/.test(adminPage.text) && adminPage.text.includes('data-testid="night-table"') && adminPage.text.includes(`result-${m1[0].id}`),
      "the organiser's session page: the publish step (published), the table, and a Result button per match",
      adminPage.status,
    );
    const xPage = await http("GET", `/admin/friendly-sessions/${night.sessionId}`, bAdmin);
    check(xPage.status === 404 && !xPage.text.includes("publish-night-table"), "another organisation's admin cannot open it", xPage.status);
    const tv = await http("GET", `/t/${night.slug}/screen?mode=bracket`);
    check(tv.status === 200 && tv.text.includes('data-testid="night-table"') && /about \d\d:\d\d/.test(tv.text), "the TV's bracket scene is the night's order of play", tv.status);
    const hero = await http("GET", "/api/mobile/v1/courts/live");
    const surfaces = { page: pubPage.text, league: lp.text, tv: tv.text, bundle: bundle.text, live: live.text, hero: hero.text };
    const publicName = Object.entries(surfaces).filter(([, t]) => t.includes(`N3 ${tag}`)).map(([k]) => k);
    check(
      publicName.length === 0 && (pubPage.text.includes(`N3 typed ${tag}`) || lp.text.includes(`N3 typed ${tag}`)),
      "a player org A only matched (org B's) is named as A typed them on the page, league page, TV, bundle, live feed and hero: never their profile's name",
      publicName,
    );

    section("5. final results on a night: the organiser and a referee");
    const first = m1[0];
    const xResult = await argsAction("enterSessionResult", [night.sessionId, first.id, { sets: [{ a: 2, b: 0 }] }], bAdmin);
    const { data: fx } = await db().from("matches").select("status").eq("id", first.id).single();
    check(!/"ok":true/.test(xResult.text) && (fx as { status: string }).status === "scheduled", "another organisation's admin cannot enter a result on our night", xResult.text.slice(0, 200));
    const oResult = await argsAction("enterSessionResult", [night.sessionId, first.id, { sets: [{ a: 2, b: 0 }] }], aAdmin);
    const { data: fr } = await db().from("matches").select("status, result_source").eq("id", first.id).single();
    const { count: ledger } = await db().from("player_score_ledger").select("id", { count: "exact", head: true }).eq("match_id", first.id);
    check(/"ok":true/.test(oResult.text) && (fr as { status: string }).status === "completed" && (fr as { result_source: string }).result_source === "final_score" && (ledger ?? 0) >= 4, "the organiser enters a final result on the session page (counted in the night's table)", { text: oResult.text.slice(0, 200), fr, ledger });
    const second = m1[1];
    const rResult = await enterResult(second.id, aReferee, [{ a: 0, b: 2 }]);
    const { data: sr } = await db().from("matches").select("status, result_source").eq("id", second.id).single();
    check(rResult.status === 200 && (sr as { status: string }).status === "completed" && (sr as { result_source: string }).result_source === "final_score", "a referee enters a final result from a phone (events API)", rResult.text.slice(0, 200));
    await db().from("friendly_sessions").update({ scoring_mode: "point_by_point" }).eq("id", night.sessionId);
    const third = m1[2];
    const refused = await enterResult(third.id, aReferee, [{ a: 2, b: 0 }]);
    const oRefused = await argsAction("enterSessionResult", [night.sessionId, third.id, { sets: [{ a: 2, b: 0 }] }], aAdmin);
    const { data: tr } = await db().from("matches").select("status").eq("id", third.id).single();
    check(refused.status >= 400 && !/"ok":true/.test(oRefused.text) && (tr as { status: string }).status === "scheduled", "a night scored point by point only refuses a final result (referee and organiser)", { r: refused.status, o: oRefused.text.slice(0, 160) });
    await db().from("friendly_sessions").update({ scoring_mode: "either" }).eq("id", night.sessionId);
    const again = await formAction("publishNightTableAction", { session_id: night.sessionId, confirm_players: "1", playing: P.slice(0, 8) }, aAdmin);
    const after = await matchesOf(T1);
    check(
      !actionOk(again) && /"ok":false/.test(again.text) && /The night has started/.test(again.text) && after.length === m1.length && after.every((m) => m1.some((x) => x.id === m.id)),
      "once the night has started its table cannot be published again (said next to the button, not an error page)",
      again.text.slice(0, 200),
    );

    section("6. the night in the live courts hero while a match is on");
    const onCourt = after.find((m) => m.status === "scheduled")!;
    const st = await start(onCourt.id, aReferee);
    check(st.status === 200, "a referee starts a match of the night", st.text.slice(0, 200));
    const heroHas = async (slug: string) => ((await http("GET", "/api/mobile/v1/courts/live")).json as { events: { tournament: { slug: string } }[] }).events.some((e) => e.tournament.slug === slug);
    check(Boolean(await eventually(() => heroHas(night.slug), 6000)), "the live courts hero shows the night (a public league's night, showcase on)");
    const { data: rulesRow } = await db().from("tournaments").select("match_day_rules").eq("id", T1).single();
    const rules = (rulesRow as { match_day_rules: Record<string, unknown> }).match_day_rules;
    await db().from("tournaments").update({ match_day_rules: { ...rules, showcase: { on: false, eventDaysOnly: true } } }).eq("id", T1);
    await sleep(1700);
    check(!(await heroHas(night.slug)), "…not when the night's showcase is off");
    await db().from("tournaments").update({ match_day_rules: rules }).eq("id", T1);
    const plain = await createFriendlySession({ name: `E2E NT Plain ${tag}`, seasonId: null, startsAt: null, durationMinutes: null, courtCount: 1, pairingMode: "americano", rankingModel: "win_points", setsToWinMatch: 1, gamesToWinSet: 2, maxPlayers: null, registrationDeadline: null, organizationId: A.id, actorRole: "admin" });
    const plainT = (plain as { tournament_id: string }).tournament_id;
    const { data: pTeams } = await db().from("teams").insert([{ tournament_id: plainT, team_name: `PA ${tag}` }, { tournament_id: plainT, team_name: `PB ${tag}` }]).select("id");
    const { data: pCourt } = await db().from("courts").select("id").eq("tournament_id", plainT).limit(1).single();
    await db().from("tournaments").update({ match_day_rules: rules, starts_on: today, ends_on: today }).eq("id", plainT);
    await db().from("matches").insert({ tournament_id: plainT, stage: "friendly", round_name: "R1", match_order: 1, status: "live", court_id: (pCourt as { id: string }).id, team_a_id: (pTeams as { id: string }[])[0].id, team_b_id: (pTeams as { id: string }[])[1].id, started_at: new Date().toISOString() });
    const { data: plainSlug } = await db().from("tournaments").select("slug").eq("id", plainT).single();
    await sleep(1700);
    check(!(await heroHas((plainSlug as { slug: string }).slug)) && (await heroHas(night.slug)), "a stand-alone session with a live match never shows; the night does again");

    section("7. re-estimates: early finishes pull the court forward, late ones push it back");
    // A one-court night of four players: one match a round, in a row on the same court.
    await updateLeague(L.id, { night_template: storedNightTemplate({ ...nightTemplate({}), courts: 1, gamesToWinSet: 2, setsToWinMatch: 1, pairingMode: "americano", scoringMode: "either" }) }, "admin");
    const night2 = await createNight(DIV, addDays(today, 1), "admin");
    const { data: ns2 } = await db().from("friendly_sessions").select("tournament_id").eq("id", night2.sessionId).single();
    const T2 = (ns2 as { tournament_id: string }).tournament_id;
    const t02 = Math.ceil((Date.now() + 2 * 3600_000) / MIN) * MIN;
    await db().from("friendly_sessions").update({ starts_at: new Date(t02).toISOString() }).eq("id", night2.sessionId);
    const pub2 = await formAction("publishNightTableAction", { session_id: night2.sessionId, confirm_players: "1", playing: P.slice(0, 4), match_minutes: "20", changeover_minutes: "5" }, aAdmin);
    let n2 = await matchesOf(T2);
    check(actionOk(pub2) && n2.length === 3 && n2.every((m, i) => at(m.scheduled_time) === t02 + i * 25 * MIN), "planned: three matches on one court, 25 minutes apart", n2.map((m) => m.scheduled_time));
    // The night is under way: it started a minute ago.
    await db().from("friendly_sessions").update({ starts_at: new Date(Date.now() - MIN).toISOString() }).eq("id", night2.sessionId);
    await reestimateSessionTable(T2);
    n2 = await matchesOf(T2);
    const planned2 = at(n2[1].scheduled_time);
    check(near(at(n2[0].scheduled_time), Date.now(), 10_000) && near(planned2, at(n2[0].scheduled_time) + 25 * MIN), "under way: the first match is due now, the next 25 minutes later", n2.map((m) => m.scheduled_time));

    const early = await enterResult(n2[0].id, aReferee, [{ a: 2, b: 0 }]);
    n2 = await matchesOf(T2);
    const end1 = at(n2[0].ended_at);
    check(
      early.status === 200 && near(at(n2[1].scheduled_time), end1 + 5 * MIN) && planned2 - at(n2[1].scheduled_time) > 15 * MIN && near(at(n2[2].scheduled_time), at(n2[1].scheduled_time) + 25 * MIN),
      "the first match finished early: the next is re-estimated to its end + changeover (≈20 minutes sooner), the one after follows",
      n2.map((m) => [m.status, m.scheduled_time, m.ended_at]),
    );

    const st2 = await start(n2[1].id, aReferee);
    const startedAt2 = await eventually(async () => {
      const r = (await matchesOf(T2))[1];
      return r.started_at ? at(r.started_at) : 0;
    });
    const onStart = await eventually(async () => {
      const r = await matchesOf(T2);
      return near(at(r[2].scheduled_time), startedAt2 + 25 * MIN) ? r : null;
    });
    check(st2.status === 200 && Boolean(onStart), "the next match goes on: the last is re-estimated from its real start (start + 20 + 5)", (await matchesOf(T2)).map((m) => m.scheduled_time));
    // Thirty-five minutes later it is still on court (it runs long): the last match moves back.
    await reestimateSessionTable(T2, startedAt2 + 35 * MIN);
    n2 = await matchesOf(T2);
    check(at(n2[2].scheduled_time) === startedAt2 + 40 * MIN, "a match that runs long pushes the court's next match back (now + changeover)", n2[2].scheduled_time);
    await enterResult(n2[1].id, aReferee, [{ a: 0, b: 2 }]);
    await db().from("matches").update({ ended_at: new Date(startedAt2 + 50 * MIN).toISOString() }).eq("id", n2[1].id);
    await reestimateSessionTable(T2, startedAt2 + 50 * MIN);
    n2 = await matchesOf(T2);
    check(at(n2[2].scheduled_time) === startedAt2 + 55 * MIN, "…and when it finishes late, the next starts at its real end + changeover", n2[2].scheduled_time);
    const queued2 = (await db().from("notification_events").select("id", { count: "exact", head: true }).eq("tournament_id", T2).eq("kind", "match_scheduled")).count ?? 0;
    check(queued2 === 3, "re-estimates do not alert again (one alert per match, at publishing)", queued2);
  } finally {
    const orgs = created.orgs;
    if (created.devices.length) {
      await db().from("notification_deliveries").delete().in("device_id", created.devices);
      await db().from("follows").delete().like("owner_id", `e2e-nt-${tag}-%`);
      await db().from("push_devices").delete().in("id", created.devices);
    }
    if (orgs.length) {
      const { data: ts } = await db().from("tournaments").select("id").in("organization_id", orgs);
      const tids = ((ts ?? []) as { id: string }[]).map((t) => t.id);
      if (tids.length) await db().from("notification_events").delete().in("tournament_id", tids);
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
    const { count } = orgs.length ? await db().from("tournaments").select("id", { count: "exact", head: true }).in("organization_id", orgs) : { count: 0 };
    check((count ?? 0) === 0, "cleanup: every night, league, player and phone made here is gone");
  }
  finish("nights");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
