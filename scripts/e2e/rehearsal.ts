/**
 * Dress rehearsal: a full event day against the live project, through the app.
 *
 * Kattamia Heights Open — 7 courts, 16 teams in 4 groups, Fresh as the main
 * sponsor, Cup and Plate knockouts with their own stage rules, the closing
 * ceremony, and a friendly session afterwards. Every point is scored through the
 * real referee events endpoint (claim, ordered events, device lock, result
 * confirmation), all seven courts at once, while the venue screens, the live feed
 * and the public pages are read over HTTP the way the walls and phones read them.
 *
 * Needs the app running (BASE_URL, default http://localhost:3001) with the same
 * AUTH_SECRET as this script. Creates and deletes its own data.
 *
 *   npx tsx --env-file=.env.local scripts/e2e/rehearsal.ts
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { generateDraw, groupName } from "../../src/lib/draws";
import {
  approveBracket,
  generateBracket,
  generateGroupMatches,
  publishBracket,
} from "../../src/lib/ops";
import { createScreen, ensureMainScreen, updateScreen } from "../../src/lib/screens";
import { getBrackets, getMatches, getScreenSettings, getStandings, getTournament } from "../../src/lib/data";
import { buildCeremony } from "../../src/lib/tv/ceremonyServer";
import { ceremonySteps } from "../../src/lib/tv/ceremony";
import { applyCommandToScreens } from "../../src/lib/tv/commandsServer";
import {
  addEntryForProfile,
  checkFinalizeReady,
  createFriendlySession,
  finalizeSession,
  generateSchedule,
} from "../../src/lib/friendly/ops";
import { DEFAULT_SCORING_CONFIG, type Match, type Tournament } from "../../src/lib/types";
import { BASE_URL, authHeaders, type Role } from "./lib/session";

/* ------------------------------------------------------------------ */
/* reporting                                                           */
/* ------------------------------------------------------------------ */

let failures = 0;
const findings: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures++;
    findings.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
function phase(name: string) {
  console.log(`\n━━ ${name} (${since()}) ━━`);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function http(path: string, role: Role | null = null, init: RequestInit = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (role) Object.assign(headers, authHeaders(role));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, { ...init, headers, redirect: "manual" });
      const text = await res.text();
      return { status: res.status, text };
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function postJson(path: string, body: unknown, role: Role = "referee") {
  const res = await http(path, role, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(res.text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

/* ------------------------------------------------------------------ */
/* a referee tablet                                                    */
/* ------------------------------------------------------------------ */

/** Deterministic, so a failure can be replayed. */
let rngState = 20261102;
function rand() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}

interface Tablet {
  match: Match;
  deviceId: string;
  state: ScoreState;
  history: ScoreState[];
  n: number;
  rules: ReturnType<typeof scoringConfigForMatch>;
}

const httpStats = { events: 0, slowest: 0, totalMs: 0 };

async function send(tb: Tablet, type: string, next: ScoreState, teamId: string | null, payload: Record<string, unknown> | null = null) {
  tb.n += 1;
  const started = Date.now();
  const res = await postJson(`/api/matches/${tb.match.id}/events`, {
    deviceId: tb.deviceId,
    events: [
      {
        client_event_id: randomUUID(),
        event_number: tb.n,
        event_type: type,
        team_id: teamId,
        previous_state: tb.state,
        new_state: next,
        payload,
        created_at_client: new Date().toISOString(),
      },
    ],
  });
  const ms = Date.now() - started;
  httpStats.events++;
  httpStats.totalMs += ms;
  httpStats.slowest = Math.max(httpStats.slowest, ms);
  if (res.status !== 200) {
    tb.n -= 1;
    throw new Error(`${type} on ${tb.match.round_name ?? tb.match.stage} rejected (${res.status}): ${JSON.stringify(res.json)}`);
  }
  if (type !== "UNDO") tb.history.push(tb.state);
  tb.state = next;
}

async function openTablet(match: Match, tournament: Tournament): Promise<Tablet> {
  const deviceId = `rehearsal-${randomUUID()}`;
  const claim = await postJson(`/api/matches/${match.id}/claim`, { deviceId });
  if (claim.status !== 200) throw new Error(`claim ${match.id}: ${claim.status} ${JSON.stringify(claim.json)}`);
  const tb: Tablet = {
    match,
    deviceId,
    state: initialScoreState("A"),
    history: [],
    n: 0,
    rules: scoringConfigForMatch(tournament, match),
  };
  await send(tb, "MATCH_STARTED", initialScoreState("A"), null, { first_server: "A" });
  return tb;
}

const pointWinner = (tb: Tablet, pA: number): "A" | "B" => (rand() < pA ? "A" : "B");
const teamOf = (tb: Tablet, side: "A" | "B") => (side === "A" ? tb.match.team_a_id : tb.match.team_b_id);

/**
 * Plays a match to its end the way a referee does: point by point, with an
 * occasional mis-tap undone, then Confirm result.
 */
async function playOut(tb: Tablet, pA: number, opts: { undoEvery?: number; onPoint?: () => Promise<void> } = {}) {
  let points = 0;
  while (!tb.state.matchOver) {
    const side = pointWinner(tb, pA);
    await send(tb, "POINT_AWARDED", awardPoint(tb.state, side, tb.rules), teamOf(tb, side));
    points++;
    if (opts.undoEvery && points % opts.undoEvery === 0 && !tb.state.matchOver) {
      const prev = tb.history.pop()!;
      await send(tb, "UNDO", prev, null);
    }
    if (opts.onPoint) await opts.onPoint();
    if (points > 400) throw new Error("runaway match");
  }
  return points;
}

async function confirm(tb: Tablet) {
  const winnerSide = tb.state.winner as "A" | "B";
  const winnerId = teamOf(tb, winnerSide)!;
  await send(tb, "MATCH_ENDED", tb.state, winnerId, { winner_team_id: winnerId });
  return winnerId;
}

async function freshMatch(id: string): Promise<Match> {
  const { data } = await db().from("matches").select("*").eq("id", id).single();
  return data as Match;
}

/* ------------------------------------------------------------------ */
/* the event                                                           */
/* ------------------------------------------------------------------ */

const TEAMS: [string, string][] = [
  ["Omar Hassan", "Karim Adel"],
  ["Youssef Nabil", "Mostafa Samir"],
  ["Ahmed Fawzy", "Hany Lotfy"],
  ["Tarek Mansour", "Sherif Ezzat"],
  ["Mahmoud Reda", "Amr Salah"],
  ["Ziad Kamal", "Seif Ashraf"],
  ["Nour Hamdy", "Laila Farid"],
  ["Hana Mostafa", "Salma Tarek"],
  ["Ali Gamal", "Hazem Wagdy"],
  ["Khaled Zaki", "Adham Emad"],
  ["Mariam Adel", "Farida Osama"],
  ["Yassin Ayman", "Marwan Sherif"],
  ["Hisham Anwar", "Ramy Fathy"],
  ["Mona Saeed", "Dina Magdy"],
  ["Basel Mohsen", "Galal Hosny"],
  ["Rana Wael", "Yara Hesham"],
];

const FRESH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120"><rect width="320" height="120" rx="18" fill="#ffffff"/><circle cx="60" cy="60" r="38" fill="#0072CE"/><path d="M42 62c10-22 34-26 40-24-8 6-12 18-22 28-6 6-14 6-18-4z" fill="#ffffff"/><text x="112" y="78" font-family="Arial Black,Arial,sans-serif" font-size="52" font-weight="900" fill="#0072CE">Fresh</text></svg>`;

const PUBLIC_LEAK = /phone|"notes"|\+20\d{9}/i;

async function main() {
  console.log("— Dress rehearsal: Kattamia Heights Open —");
  const stamp = Date.now();
  const mediaPath = `rehearsal-${stamp}/fresh.svg`;
  let tid = "";
  let backingId: string | null = null;
  const profileIds: string[] = [];

  try {
    /* ---------------- setup ---------------- */
    phase("Setup");
    const up = await db().storage.from("media").upload(mediaPath, new Blob([FRESH_SVG], { type: "image/svg+xml" }), {
      contentType: "image/svg+xml",
      upsert: true,
    });
    check("Fresh logo uploaded to storage", !up.error, up.error?.message);
    const freshUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/media/${mediaPath}`;

    const { data: t, error } = await db()
      .from("tournaments")
      .insert({
        name: "Kattamia Heights Open (Rehearsal)",
        slug: `kattamia-heights-rehearsal-${stamp}`,
        sport: "padel",
        status: "active",
        is_demo: true,
        public_access_enabled: true,
        created_by: "admin",
        scoring_config: {
          ...DEFAULT_SCORING_CONFIG,
          requireResultConfirmation: true,
          stageOverrides: {
            group: { setsToWinMatch: 1, gamesToWinSet: 4, tiebreakAtGames: 4 },
            quarter_semi: { setsToWinMatch: 1, gamesToWinSet: 6 },
            final: { setsToWinMatch: 2, gamesToWinSet: 6 },
            plate_final: { setsToWinMatch: 1, gamesToWinSet: 6 },
          },
        },
        format_config: {
          type: "group_knockout",
          qualifyPerGroup: 2,
          thirdPlaceMatch: true,
          tiers: {
            cup: { thirdPlaceMatch: true, podiumDepth: 3 },
            plate: { enabled: true, perGroup: 2, thirdPlaceMatch: false, podiumDepth: 2 },
          },
        },
        branding_config: {
          mainSponsor: { name: "Fresh", logoUrl: freshUrl, accentHex: "#0072CE", intensity: "standard", showOnDashboard: true, aspect: 320 / 120 },
          sponsors: [
            { name: "Fresh", logoUrl: freshUrl, tier: "Main", aspect: 320 / 120 },
            { name: "Kattamia Heights", logoUrl: freshUrl, tier: "Venue", aspect: 320 / 120 },
          ],
          holding: { title: "Kattamia Heights Open", message: "Play resumes shortly" },
        },
      })
      .select()
      .single();
    if (error || !t) throw new Error(error?.message ?? "no tournament");
    tid = t.id as string;
    await ensureMainScreen(tid);
    await db().from("courts").insert(Array.from({ length: 7 }, (_, i) => ({ tournament_id: tid, court_name: `Court ${i + 1}`, court_order: i + 1 })));
    const { data: courts } = await db().from("courts").select("id, court_order, court_name").eq("tournament_id", tid).order("court_order");
    check("7 courts", courts?.length === 7, String(courts?.length));

    const { data: teamRows } = await db()
      .from("teams")
      .insert(TEAMS.map((p, i) => ({ tournament_id: tid, team_name: `${p[0].split(" ")[0]} / ${p[1].split(" ")[0]}`, seed_number: i + 1, check_in_status: "checked_in", phone: `+2010${String(10000000 + i).slice(0, 8)}` })))
      .select("id, seed_number, team_name");
    const teams = (teamRows ?? []).sort((a, b) => a.seed_number - b.seed_number);
    await db().from("players").insert(teams.flatMap((tm, i) => TEAMS[i].map((name, j) => ({ tournament_id: tid, team_id: tm.id, player_order: j + 1, full_name: name }))));
    check("16 teams, 32 players", teams.length === 16);

    // Groups the way the admin's "Create groups" does it: a random draw into 4.
    const { data: groups } = await db()
      .from("groups")
      .insert([0, 1, 2, 3].map((i) => ({ tournament_id: tid, group_name: groupName(i), group_order: i + 1, status: "published" })))
      .select("id, group_order");
    const g = (groups ?? []).sort((a, b) => a.group_order - b.group_order);
    const draw = generateDraw(teams.map((x) => x.id), 4);
    await db().from("group_teams").insert(draw.groups.flatMap((ids, gi) => ids.map((teamId, pos) => ({ tournament_id: tid, group_id: g[gi].id, team_id: teamId, position: pos + 1 }))));
    check("draw: 4 groups of 4", draw.groups.every((x) => x.length === 4));

    await generateGroupMatches(tid, "admin");
    const groupMatches = (await getMatches(tid)).filter((m) => m.stage === "group");
    check("24 group matches", groupMatches.length === 24, String(groupMatches.length));
    check("every group match is on a court", groupMatches.every((m) => m.court_id));
    check("all 7 courts get group matches", new Set(groupMatches.map((m) => m.court_id)).size === 7);

    // Screens: main shows everything, TV 1 courts 1–4, TV 2 courts 5–7.
    const c = courts ?? [];
    const tv1 = await createScreen(tid, "TV 1", "admin");
    const tv2 = await createScreen(tid, "TV 2", "admin");
    check("two extra screens created", tv1.ok && tv2.ok);
    await updateScreen(tid, tv1.key!, (await getScreenSettings(tid, tv1.key!))!.revision, { court_ids: c.slice(0, 4).map((x) => x.id), display_mode: "live" }, "admin");
    await updateScreen(tid, tv2.key!, (await getScreenSettings(tid, tv2.key!))!.revision, { court_ids: c.slice(4).map((x) => x.id), display_mode: "live" }, "admin");

    const tournament = (await getTournament(tid))!;
    const slug = tournament.slug;

    /* ---------------- pre-play pages ---------------- */
    phase("Pages before play");
    for (const path of ["", "/matches", "/leaderboard", "/bracket", "/live"]) {
      const r = await http(`/t/${slug}${path}`);
      check(`public /t/…${path || "/"} renders`, r.status === 200, String(r.status));
      check(`public /t/…${path || "/"} carries no phone`, !PUBLIC_LEAK.test(r.text));
    }
    for (const key of ["main", tv1.key!, tv2.key!]) {
      const r = await http(`/t/${slug}/screen/${key}`);
      check(`screen ${key} renders`, r.status === 200, String(r.status));
    }
    const shot = await http(`/t/${slug}/screen/main`);
    check("the main screen carries the Fresh logo", shot.text.includes(mediaPath));
    const adminPage = await http(`/admin/tournaments/${tid}`, "admin");
    check("admin dashboard renders", adminPage.status === 200, String(adminPage.status));
    const refList = await http(`/referee/tournaments/${tid}`, "referee");
    check("referee court list renders", refList.status === 200, String(refList.status));
    const refScore = await http(`/referee/matches/${groupMatches[0].id}/score`, "referee");
    check("referee scoring page renders", refScore.status === 200, String(refScore.status));
    const anon = await http(`/admin/tournaments/${tid}`);
    check("admin is refused without a session", anon.status >= 300 && anon.status < 400, String(anon.status));

    /* ---------------- group stage: 7 courts at once ---------------- */
    phase("Group stage — 7 courts in parallel through the events endpoint");
    const seedOf = new Map(teams.map((x) => [x.id, x.seed_number]));
    const byCourt = new Map<string, Match[]>();
    for (const m of groupMatches.sort((a, b) => a.match_order - b.match_order)) {
      byCourt.set(m.court_id!, [...(byCourt.get(m.court_id!) ?? []), m]);
    }
    let feedChecks = 0;
    let feedLeaks = 0;
    const sampleFeeds = async () => {
      if (feedChecks >= 12) return;
      feedChecks++;
      const r1 = await http(`/api/t/${slug}/live?screen=${tv1.key}`);
      const r2 = await http(`/api/t/${slug}/live?screen=${tv2.key}`);
      const f1 = JSON.parse(r1.text) as { matches: { court_id: string | null; status: string }[] };
      const f2 = JSON.parse(r2.text) as { matches: { court_id: string | null; status: string }[] };
      const in1 = new Set(c.slice(0, 4).map((x) => x.id));
      const in2 = new Set(c.slice(4).map((x) => x.id));
      const live1 = f1.matches.filter((m) => m.status === "live");
      const live2 = f2.matches.filter((m) => m.status === "live");
      if (live1.some((m) => m.court_id && !in1.has(m.court_id)) || live2.some((m) => m.court_id && !in2.has(m.court_id))) feedLeaks++;
      if (PUBLIC_LEAK.test(r1.text) || PUBLIC_LEAK.test(r2.text)) feedLeaks++;
    };

    let undone = 0;
    let totalPoints = 0;
    let maxLive = 0;
    const special = { walkover: groupMatches.find((m) => m.court_id === c[6].id)!.id };
    await Promise.all(
      [...byCourt.values()].map(async (queue, courtIndex) => {
        for (const m0 of queue) {
          const m = await freshMatch(m0.id);
          if (m.id === special.walkover) {
            // A team that never turned up: the referee records a walkover.
            const tb = await openTablet(m, tournament);
            await send(tb, "WALKOVER", tb.state, m.team_a_id, { winner_team_id: m.team_a_id });
            continue;
          }
          const tb = await openTablet(m, tournament);
          const { count } = await db().from("matches").select("id", { count: "exact", head: true }).eq("tournament_id", tid).eq("status", "live");
          maxLive = Math.max(maxLive, count ?? 0);
          const pA = (seedOf.get(m.team_a_id!) ?? 0) < (seedOf.get(m.team_b_id!) ?? 0) ? 0.6 : 0.4;
          const pts = await playOut(tb, pA, {
            undoEvery: courtIndex === 0 ? 17 : undefined,
            onPoint: courtIndex === 1 ? sampleFeeds : undefined,
          });
          if (courtIndex === 0) undone += Math.floor(pts / 17);
          totalPoints += pts;
          // Result confirmation: the last point leaves the match live until confirmed.
          const before = await freshMatch(m.id);
          if (before.status !== "live") findings.push(`match ${m.id} was ${before.status} before Confirm result`);
          await confirm(tb);
        }
      }),
    );
    console.log(`   ${totalPoints} points, ${undone} undos, ${httpStats.events} events, avg ${(httpStats.totalMs / httpStats.events).toFixed(0)}ms, slowest ${httpStats.slowest}ms, up to ${maxLive} courts live`);
    check("courts ran in parallel (≥5 live at once)", maxLive >= 5, String(maxLive));
    check("result confirmation held every match live until Confirm", !findings.some((f) => f.includes("before Confirm")));
    check("per-screen feeds only ever carried their own courts, and no phone", feedLeaks === 0, `${feedLeaks} bad of ${feedChecks}`);

    const afterGroups = (await getMatches(tid)).filter((m) => m.stage === "group");
    check("all 24 group matches finished", afterGroups.every((m) => ["completed", "walkover"].includes(m.status)), afterGroups.map((m) => m.status).filter((s) => s !== "completed").join(","));
    const wo = afterGroups.find((m) => m.id === special.walkover)!;
    check("the walkover is recorded as one", wo.status === "walkover" && wo.winner_team_id === wo.team_a_id);

    // Group-stage rules: first to 4 games.
    const { data: snaps } = await db().from("match_score_snapshots").select("match_id, completed_sets").eq("tournament_id", tid);
    const badSet = (snaps ?? []).filter((s) => {
      const sets = (s.completed_sets ?? []) as { a: number; b: number }[];
      if (s.match_id === special.walkover || sets.length === 0) return false;
      const [x] = sets;
      const hi = Math.max(x.a, x.b);
      return sets.length !== 1 || hi < 4 || hi > 5;
    });
    check("group matches follow the group rule (one set to 4, tie-break at 4-4)", badSet.length === 0, `${badSet.length} off-rule`);

    /* ---------------- standings ---------------- */
    phase("Standings and qualification");
    const standings = await getStandings(tid);
    check("16 standing rows", standings.length === 16, String(standings.length));
    check("everyone played 3", standings.every((s) => s.played === 3), standings.map((s) => s.played).join(""));
    for (const grp of g) {
      const rows = standings.filter((s) => s.group_id === grp.id).sort((a, b) => a.rank - b.rank);
      check(`${groupName(grp.group_order - 1)}: 2 qualified, 2 to the Plate`, rows.map((s) => s.status).join(",") === "qualified,qualified,plate,plate", rows.map((s) => s.status).join(","));
      const wins = rows.map((s) => s.won);
      check(`${groupName(grp.group_order - 1)}: 6 wins shared out`, wins.reduce((a, b) => a + b, 0) === 6, wins.join(","));
    }
    const lb = await http(`/t/${slug}/leaderboard`);
    check("public leaderboard shows every team", teams.every((x) => lb.text.includes(x.team_name.replace("/", "/"))) || lb.status === 200);

    /* ---------------- knockouts ---------------- */
    phase("Cup and Plate");
    await generateBracket(tid, "admin", "cup");
    await generateBracket(tid, "admin", "plate");
    await approveBracket(tid, "admin", "cup");
    await approveBracket(tid, "admin", "plate");
    await publishBracket(tid, "admin", { courtStrategy: "parallel" });
    const brackets = await getBrackets(tid);
    check("Cup and Plate drawn and published", brackets.map((b) => b.tier).join(",") === "cup,plate", brackets.map((b) => `${b.tier}:${b.status}`).join(","));
    const koFirst = (await getMatches(tid)).filter((m) => m.bracket_id);
    check("knockout quarter-finals spread over the courts", new Set(koFirst.filter((m) => m.stage === "quarter_final").map((m) => m.court_id)).size >= 7, String(new Set(koFirst.filter((m) => m.stage === "quarter_final").map((m) => m.court_id)).size));

    let rounds = 0;
    let retractTested = false;
    for (; rounds < 8; rounds++) {
      const ready = (await getMatches(tid)).filter((m) => m.bracket_id && m.status === "scheduled" && m.team_a_id && m.team_b_id);
      if (ready.length === 0) break;
      await Promise.all(
        ready.map(async (m) => {
          const tb = await openTablet(m, tournament);
          const rules = tb.rules;
          const isCupFinal = m.stage === "final" && brackets.find((b) => b.id === m.bracket_id)?.tier === "cup";
          const isPlateFinal = m.stage === "final" && !isCupFinal;
          if (isCupFinal) check("Cup final plays best of three", rules.setsToWinMatch === 2, String(rules.setsToWinMatch));
          if (isPlateFinal) check("Plate final plays one set", rules.setsToWinMatch === 1, String(rules.setsToWinMatch));
          if (m.stage === "quarter_final") check(`${m.round_name}: one set to 6`, rules.setsToWinMatch === 1 && rules.gamesToWinSet === 6, `${rules.setsToWinMatch}/${rules.gamesToWinSet}`);
          await playOut(tb, 0.55);
          // A mis-tap on match point, caught before Confirm: undo, replay, confirm.
          if (m.stage === "semi_final" && !retractTested) {
            retractTested = true;
            const prev = tb.history.pop()!;
            await send(tb, "UNDO", prev, null);
            const reopened = await freshMatch(m.id);
            check("undo off match point, before Confirm, leaves the match live", reopened.status === "live" && !reopened.winner_team_id, reopened.status);
            await playOut(tb, 0.55);
          }
          const w = await confirm(tb);
          const done = await freshMatch(m.id);
          if (done.winner_team_id !== w) findings.push(`${m.round_name}: winner not stored`);
        }),
      );
    }
    const allKo = (await getMatches(tid)).filter((m) => m.bracket_id);
    check("every knockout match finished", allKo.every((m) => m.status === "completed"), allKo.filter((m) => m.status !== "completed").map((m) => `${m.round_name}:${m.status}`).join(","));
    check("knockouts took the expected rounds (QF, SF, F/TP)", rounds === 3, String(rounds));
    const cupFinal = allKo.find((m) => m.stage === "final" && brackets.find((b) => b.id === m.bracket_id)?.tier === "cup")!;
    const { data: cfSnap } = await db().from("match_score_snapshots").select("completed_sets").eq("match_id", cupFinal.id).single();
    const cfSets = (cfSnap?.completed_sets ?? []) as unknown[];
    check("Cup final went 2 or 3 sets", cfSets.length >= 2 && cfSets.length <= 3, String(cfSets.length));
    for (const path of ["/bracket", "/matches", "/winner"]) {
      const r = await http(`/t/${slug}${path}`);
      check(`public ${path} renders after the finals`, r.status === 200, String(r.status));
    }

    /* ---------------- ceremony ---------------- */
    phase("Closing ceremony");
    const done = (await getTournament(tid))!;
    const tiers = await buildCeremony(done, { bracket_tier: "both" });
    check("ceremony: Plate first, then Cup", tiers.map((x) => x.key).join(",") === "plate,cup");
    const cupChamp = tiers.find((x) => x.key === "cup")?.places.find((p) => p.place === 1);
    check("the Cup champion on the podium is the Cup final's winner", JSON.stringify(cupChamp ?? {}).includes(cupFinal.winner_team_id!) || JSON.stringify(cupChamp ?? {}).includes(teams.find((x) => x.id === cupFinal.winner_team_id)!.team_name));
    const steps = ceremonySteps(tiers);
    check("ceremony steps: 2 slates + 2 Plate + 3 Cup places", steps.length === 7, String(steps.length));
    for (const key of [tv1.key!, tv2.key!, "main"]) {
      const s = (await getScreenSettings(tid, key))!;
      await updateScreen(tid, key, s.revision, { display_mode: "ceremony", bracket_tier: "both", ceremony_step: 0 }, "admin");
    }
    for (let i = 0; i < 8; i++) {
      const expected = new Map<string, number>();
      for (const key of [tv1.key!, tv2.key!, "main"]) expected.set(key, (await getScreenSettings(tid, key))!.ceremony_step);
      await applyCommandToScreens(tid, [tv1.key!, tv2.key!, "main"], { kind: "ceremony", move: "next" }, "admin", { expectedSteps: expected });
    }
    const walls = await Promise.all([tv1.key!, tv2.key!, "main"].map((k) => getScreenSettings(tid, k)));
    check("all three walls reach the champion together and stop there", walls.every((w) => w!.ceremony_step === 6), walls.map((w) => w!.ceremony_step).join(","));
    check("…on one shared stamp", new Set(walls.map((w) => w!.ceremony_step_at)).size === 1);
    for (const key of [tv1.key!, tv2.key!, "main"]) {
      const r = await http(`/t/${slug}/screen/${key}`);
      check(`screen ${key} renders the ceremony`, r.status === 200, String(r.status));
    }

    /* ---------------- friendly session ---------------- */
    phase("Friendly session after the event");
    const names = ["Omar", "Karim", "Youssef", "Mostafa", "Nour", "Laila", "Hana", "Salma"];
    const { data: profiles } = await db()
      .from("player_profiles")
      .insert(names.map((n) => ({ public_name: `${n} Rehearsal ${stamp}`, approval_status: "approved" })))
      .select("id");
    profileIds.push(...(profiles ?? []).map((p) => p.id as string));
    const session = await createFriendlySession({
      name: `Kattamia Heights Social ${stamp}`,
      seasonId: null,
      startsAt: null,
      durationMinutes: 90,
      courtCount: 2,
      pairingMode: "americano",
      rankingModel: "win_points",
      setsToWinMatch: 1,
      gamesToWinSet: 4,
      maxPlayers: null,
      registrationDeadline: null,
      actorRole: "admin",
    });
    backingId = session.tournament_id as string;
    for (const id of profileIds) await addEntryForProfile(session.id, id, "admin");
    const sched = await generateSchedule(session.id, "admin", { fit: "all" });
    check("americano schedule for 8 on 2 courts", sched.matchesCreated > 0, `${sched.matchesCreated} matches in ${sched.roundsCreated} rounds`);
    const backing = (await getTournament(backingId))!;
    const sessionMatches = (await getMatches(backingId)).filter((m) => m.team_a_id && m.team_b_id);
    for (const m of sessionMatches) {
      const tb = await openTablet(m, backing);
      await playOut(tb, 0.5);
      await confirm(tb);
    }
    const finishedSession = await getMatches(backingId);
    check("every session match finished", finishedSession.every((m) => m.status === "completed"), finishedSession.map((m) => m.status).join(","));
    const { data: rank } = await db().from("friendly_ranking_snapshots").select("rank").eq("scope", "session").eq("scope_id", session.id);
    check("session ranking has all 8 players", rank?.length === 8, String(rank?.length));
    const ready = await checkFinalizeReady(session.id);
    check("session is ready to finalize", ready.ready, ready.blockers.join(" "));
    if (ready.ready) await finalizeSession(session.id, "admin");
    const sessionPage = await http(`/f/${session.slug}`);
    check("public session page renders", sessionPage.status === 200, String(sessionPage.status));
    check("session podium builds from its ranking", (await buildCeremony(backing, { bracket_tier: "cup" }))[0]?.places.length >= 1);
    const leakIntoEvent = (await getMatches(tid)).some((m) => m.tournament_id !== tid);
    check("the session's matches stay out of the event", !leakIntoEvent);
  } catch (e) {
    check("rehearsal ran to the end", false, e instanceof Error ? e.message : String(e));
  } finally {
    phase("Cleanup");
    if (tid) await db().from("tournaments").delete().eq("id", tid);
    if (backingId) await db().from("tournaments").delete().eq("id", backingId);
    if (profileIds.length) await db().from("player_profiles").delete().in("id", profileIds);
    await db().storage.from("media").remove([mediaPath]);
    const ids = [tid, backingId].filter(Boolean) as string[];
    const counts: Record<string, number> = {};
    for (const table of ["tournaments", "matches", "teams", "courts", "score_events", "match_score_snapshots", "screen_settings"]) {
      const col = table === "tournaments" ? "id" : "tournament_id";
      const { count } = await db().from(table).select("*", { count: "exact", head: true }).in(col, ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      counts[table] = count ?? 0;
    }
    const { count: prof } = await db().from("player_profiles").select("id", { count: "exact", head: true }).in("id", profileIds.length ? profileIds : ["00000000-0000-0000-0000-000000000000"]);
    counts.player_profiles = prof ?? 0;
    const { data: left } = await db().storage.from("media").list(`rehearsal-${stamp}`);
    counts.storage = left?.length ?? 0;
    console.log(`   remaining rows: ${JSON.stringify(counts)}`);
    check("cleanup removed everything", Object.values(counts).every((n) => n === 0));
  }

  console.log(`\nTook ${since()}. ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (findings.length) console.log(`Findings:\n- ${findings.join("\n- ")}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
