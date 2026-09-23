/**
 * Phase 2 gate: a 16-nation team competition from the draw to 16th place.
 *
 * Sixteen nations in four groups of four; every tie three rubbers under real
 * tennis rules (singles best of three, doubles no-ad with a match tie-break);
 * captains' line-ups, locked, with a refused and an audited late change; the
 * ITF group ranking; the placement draws for 1st–8th and 9th–16th; dead
 * doubles dropped at 2-0 in the placement ties but played in the groups; an undo
 * that reopens a deciding rubber; and every place from 1 to 16 decided once.
 *
 * Most rubbers are scored through the same server functions the events route
 * calls. One full group tie and one placement tie go through the real referee
 * events endpoint over HTTP, including the undo, so the route's tie handling is
 * exercised too. Needs the app running (BASE_URL) — the local stand-in is fine:
 *
 *   npm run localdb & (SUPABASE_URL=http://localhost:54321 npx next start -p 3002) &
 *   npx tsx --env-file=.env.localdb scripts/e2e/tennis-ties.ts
 *
 * Creates and deletes its own data.
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { finalizeMatch, generateGroupMatches, upsertSnapshotFromState } from "../../src/lib/ops";
import { ensureMainScreen } from "../../src/lib/screens";
import { getMatches, getStandings, getTeams, getTournament } from "../../src/lib/data";
import { drawPlacement, finalPlacings, getTies, lockLineups, setLineup } from "../../src/lib/tennis/tieOps";
import { nationByCode } from "../../src/lib/tennis/nations";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Match, type Tie, type Tournament } from "../../src/lib/types";
import { BASE_URL, authHeaders } from "./lib/session";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const phase = (name: string) => console.log(`\n━━ ${name} ━━`);

/* ---------------- the field: 16 nations, seeded ---------------- */
const FIELD: [string, string[]][] = [
  ["USA", ["Julieta Pareja", "Kristina Penickova", "Annika Penickova"]],
  ["ROU", ["Giulia Safina Popa", "Maia Ilinca Burcescu", "Ana Ionescu"]],
  ["CZE", ["Tereza Novak", "Klara Dvorak", "Ema Kral"]],
  ["JPN", ["Yui Tanaka", "Hana Sato", "Mio Suzuki"]],
  ["FRA", ["Cindy Langlais", "Lea Martin", "Chloe Bernard"]],
  ["EGY", ["Judy Tawila", "Farida Hassan", "Laila Adel"]],
  ["CAN", ["Nadia Lagaev", "Charlize Celebrini", "Emma Roy"]],
  ["ESP", ["Lucia Garcia", "Paula Lopez", "Marta Ruiz"]],
  ["ITA", ["Giulia Rossi", "Sofia Bianchi", "Aurora Greco"]],
  ["GBR", ["Amelia Smith", "Olivia Jones", "Isla Brown"]],
  ["AUS", ["Ruby Wilson", "Mia Taylor", "Zoe Walker"]],
  ["IND", ["Ananya Rao", "Diya Shah", "Isha Nair"]],
  ["BRA", ["Ana Souza", "Julia Lima", "Bia Costa"]],
  ["KOR", ["Ji-woo Kim", "Seo-yeon Lee", "Min-ji Park"]],
  ["GER", ["Lena Muller", "Mia Schmidt", "Emma Weber"]],
  ["ARG", ["Sofia Gomez", "Valentina Diaz", "Camila Perez"]],
];

async function http(path: string, init: RequestInit = {}, role: "admin" | "referee" = "admin") {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { ...authHeaders(role), ...(init.headers as Record<string, string>) }, redirect: "manual" });
  return { status: res.status, text: await res.text() };
}

/** Deterministic "who wins this point": the stronger side takes about 60%. */
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function rules(t: Tournament, m: Match) {
  return scoringConfigForMatch(t, m, null, { doubles: m.rubber_type === "D" });
}

/** Plays a rubber point by point until `winner` has it (the loser takes some games). */
function playTo(t: Tournament, m: Match, winner: TeamKey, strength = 0.62): ScoreState[] {
  const cfg = rules(t, m);
  const loser: TeamKey = winner === "A" ? "B" : "A";
  let s = initialScoreState("A");
  const trail = [s];
  let guard = 0;
  while (!s.matchOver) {
    s = awardPoint(s, rand() < strength ? winner : loser, cfg);
    trail.push(s);
    if (++guard > 2000) throw new Error("runaway rubber");
  }
  if (s.winner !== winner) return playTo(t, m, winner, Math.min(0.95, strength + 0.1));
  return trail;
}

/** Scores a rubber through the server functions the events route itself calls. */
async function finishDirect(t: Tournament, m: Match, winner: TeamKey) {
  const trail = playTo(t, m, winner);
  const final = trail[trail.length - 1];
  await upsertSnapshotFromState(m, final, trail.length);
  await finalizeMatch(m, { status: "completed", winnerTeamId: winner === "A" ? m.team_a_id! : m.team_b_id!, actorRole: "e2e" });
  return final;
}

/** Scores a rubber through the real events endpoint, as a referee phone does. */
async function finishHttp(t: Tournament, m: Match, winner: TeamKey) {
  const deviceId = `ties-${randomUUID()}`;
  const claim = await http(`/api/matches/${m.id}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId }) }, "referee");
  if (claim.status !== 200) throw new Error(`claim ${claim.status} ${claim.text}`);
  const trail = playTo(t, m, winner);
  let n = 0;
  const post = async (type: string, prev: ScoreState | null, next: ScoreState, teamId: string | null, payload: unknown = null) => {
    n++;
    const res = await http(
      `/api/matches/${m.id}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          events: [{ client_event_id: randomUUID(), event_number: n, event_type: type, team_id: teamId, previous_state: prev, new_state: next, payload, created_at_client: new Date().toISOString() }],
        }),
      },
      "referee",
    );
    if (res.status !== 200) throw new Error(`${type} ${res.status} ${res.text}`);
  };
  await post("MATCH_STARTED", null, trail[0], null, { first_server: "A" });
  for (let i = 1; i < trail.length; i++) await post("POINT_AWARDED", trail[i - 1], trail[i], null);
  const final = trail[trail.length - 1];
  const wid = winner === "A" ? m.team_a_id! : m.team_b_id!;
  await post("MATCH_ENDED", final, final, wid, { winner_team_id: wid });
  return { deviceId, trail, events: n, post };
}

async function main() {
  console.log("— Tennis team competition: 16 nations, draw to 16th place —");
  const { data: t0, error } = await db()
    .from("tournaments")
    .insert({
      name: "E2E Junior Team Finals",
      slug: `e2e-junior-team-finals-${Date.now()}`,
      sport: "tennis",
      status: "active",
      is_demo: true,
      public_access_enabled: true,
      scoring_config: { ...DEFAULT_TENNIS_SCORING_CONFIG, requireResultConfirmation: true },
      format_config: { type: "group_knockout", qualifyPerGroup: 2, thirdPlaceMatch: false, ties: {} },
    })
    .select()
    .single();
  if (error || !t0) throw new Error(error?.message ?? "no tournament");
  const tid = t0.id as string;
  try {
    await ensureMainScreen(tid);
    await db().from("courts").insert([1, 2].map((n) => ({ tournament_id: tid, court_name: `Court ${n}`, court_order: n })));
    const t = (await getTournament(tid))!;

    phase("Nations");
    for (const [i, [code, players]] of FIELD.entries()) {
      const nation = nationByCode(code)!;
      const { data: team } = await db()
        .from("teams")
        .insert({ tournament_id: tid, team_name: nation.name, nation_code: code, iso2: nation.iso2, captain_name: `Captain ${code}`, seed_number: i + 1, check_in_status: "checked_in" })
        .select()
        .single();
      await db().from("players").insert(players.map((full_name, j) => ({ tournament_id: tid, team_id: team!.id, player_order: j + 1, full_name })));
    }
    const teams = await getTeams(tid);
    check("16 nations, 3 players each, with flags", teams.length === 16 && teams.every((x) => x.players?.length === 3 && x.iso2), String(teams.length));
    const nationPage = await http(`/admin/tournaments/${tid}/nations`);
    check("the Nations page renders every nation", nationPage.status === 200 && (nationPage.text.match(/data-testid="nation-row"/g) ?? []).length === 16, String(nationPage.status));

    phase("Groups and group ties");
    // Seeds 1–4 head the groups; the rest snake down (5–8 in reverse, …).
    const bySeed = [...teams].sort((a, b) => a.seed_number! - b.seed_number!);
    const { data: groups } = await db()
      .from("groups")
      .insert(["A", "B", "C", "D"].map((g, i) => ({ tournament_id: tid, group_name: `Group ${g}`, group_order: i + 1, status: "published" })))
      .select();
    const g = (groups ?? []).sort((a, b) => a.group_order - b.group_order);
    const snake = (i: number) => {
      const row = Math.floor(i / 4);
      const col = i % 4;
      return row % 2 === 0 ? col : 3 - col;
    };
    await db().from("group_teams").insert(bySeed.map((team, i) => ({ tournament_id: tid, group_id: g[snake(i)].id, team_id: team.id, position: Math.floor(i / 4) + 1 })));
    await generateGroupMatches(tid, "e2e");
    let ties = await getTies(tid);
    let matches = await getMatches(tid);
    check("24 group ties", ties.length === 24 && ties.every((x) => x.stage === "group"), String(ties.length));
    check("72 rubbers, three per tie", matches.length === 72 && ties.every((x) => matches.filter((m) => m.tie_id === x.id).length === 3), String(matches.length));
    const order = matches.filter((m) => m.tie_id === ties[0].id).sort((a, b) => a.rubber_no! - b.rubber_no!).map((m) => m.rubber_type).join(",");
    check("order of play: No. 2 singles, No. 1 singles, doubles", order === "S2,S1,D", order);

    const waiting = await http(`/referee/matches/${matches[0].id}/score`, {}, "referee");
    check("the referee phone waits for line-ups before a rubber can start", waiting.status === 200 && waiting.text.includes("Waiting for the line-ups"), String(waiting.status));

    phase("Line-ups");
    const teamBy = new Map(teams.map((x) => [x.id, x]));
    const squad = (id: string) => teamBy.get(id)!.players!.sort((a, b) => a.player_order - b.player_order).map((p) => p.id);
    const bad = await setLineup(ties[0].id, "A", { S1: squad(ties[0].team_a_id!)[0], S2: squad(ties[0].team_a_id!)[0], D: [squad(ties[0].team_a_id!)[0], squad(ties[0].team_a_id!)[1]] }, "e2e");
    check("one player in both singles is refused", !bad.ok && bad.message.includes("both singles"), bad.ok ? "accepted" : bad.message);
    const nominate = async (tie: Tie) => {
      for (const side of ["A", "B"] as const) {
        const s = squad((side === "A" ? tie.team_a_id : tie.team_b_id)!);
        const r = await setLineup(tie.id, side, { S1: s[0], S2: s[1], D: [s[0], s[2]] }, "e2e");
        if (!r.ok) throw new Error(r.message);
      }
    };
    for (const tie of ties) await nominate(tie);
    const locked = await lockLineups(ties[0].id, "e2e");
    check("line-ups lock once both sides have nominated", locked.ok);
    const s0 = squad(ties[0].team_a_id!);
    const late = await setLineup(ties[0].id, "A", { S1: s0[2], S2: s0[1], D: [s0[0], s0[1]] }, "e2e");
    check("a change after the lock is refused without a reason", !late.ok && late.message.includes("locked"));
    const lateOk = await setLineup(ties[0].id, "A", { S1: s0[2], S2: s0[1], D: [s0[0], s0[1]] }, "e2e", { lateChangeReason: "Injury in warm-up" });
    const { count: lateAudits } = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("tournament_id", tid).eq("action", "LINEUP_LATE_CHANGE");
    check("…and accepted with one, recorded as a late change", lateOk.ok && lateAudits === 1, String(lateAudits));
    matches = await getMatches(tid);
    const s1 = matches.find((m) => m.tie_id === ties[0].id && m.rubber_type === "S1")!;
    check("the late change reached the rubber", s1.team_a_player_ids?.[0] === s0[2]);
    const refPage = await http(`/referee/matches/${s1.id}/score`, {}, "referee");
    const nominee = teamBy.get(ties[0].team_a_id!)!.players!.find((p) => p.id === s0[2])!.full_name.split(" ").slice(-1)[0];
    check("the referee phone shows the nominated player, not the squad", refPage.status === 200 && refPage.text.includes(nominee), nominee);

    phase("Group stage");
    const seedOf = (id: string) => teamBy.get(id)!.seed_number!;
    // Through the real events endpoint: every rubber of the first tie, dead doubles included.
    const httpTie = ties[0];
    const httpRubbers = matches.filter((m) => m.tie_id === httpTie.id).sort((a, b) => a.rubber_no! - b.rubber_no!);
    const better: TeamKey = seedOf(httpTie.team_a_id!) < seedOf(httpTie.team_b_id!) ? "A" : "B";
    let events = 0;
    for (const r of httpRubbers) events += (await finishHttp(t, r, better)).events;
    const afterHttp = (await getTies(tid)).find((x) => x.id === httpTie.id)!;
    check("a tie scored on referee phones: 3-0, all three rubbers played in the group", afterHttp.status === "completed" && afterHttp.rubbers_a + afterHttp.rubbers_b === 3, `${afterHttp.rubbers_a}-${afterHttp.rubbers_b} over ${events} events`);

    // Everything else through the server functions. The stronger seed wins the
    // singles; the doubles goes the other way now and then, and one upset per
    // group makes the ranking earn its keep.
    matches = await getMatches(tid);
    for (const tie of ties.slice(1)) {
      const rs = matches.filter((m) => m.tie_id === tie.id).sort((a, b) => a.rubber_no! - b.rubber_no!);
      const fav: TeamKey = seedOf(tie.team_a_id!) < seedOf(tie.team_b_id!) ? "A" : "B";
      const dog: TeamKey = fav === "A" ? "B" : "A";
      const upset = tie.round_no === 3 && tie.tie_order % 2 === 0;
      for (const r of rs) {
        const w = r.rubber_type === "D" ? (rand() < 0.3 ? dog : fav) : upset && r.rubber_type === "S2" ? dog : fav;
        await finishDirect(t, r, w);
      }
    }
    ties = await getTies(tid);
    matches = await getMatches(tid);
    check("every group tie finished", ties.every((x) => x.status === "completed"), ties.filter((x) => x.status !== "completed").length + " open");
    check("no group rubber was dropped: dead rubbers are played in the groups", matches.every((m) => m.status === "completed"), matches.filter((m) => m.status !== "completed").map((m) => m.status).join(","));
    const tieScoresValid = ties.every((x) => x.rubbers_a + x.rubbers_b === 3 && Math.max(x.rubbers_a, x.rubbers_b) >= 2);
    check("every tie score adds up to three rubbers", tieScoresValid);
    const dtDoubles = matches.find((m) => m.tie_id === ties[5].id && m.rubber_type === "D")!;
    const { data: dSnap } = await db().from("match_score_snapshots").select("snapshot_json").eq("match_id", dtDoubles.id).single();
    const dState = dSnap!.snapshot_json as ScoreState;
    check("doubles are played no-ad, with a match tie-break at one set all when it comes to that", dState.completedSets.length === 2 || dState.completedSets[2]?.matchTiebreak === true, JSON.stringify(dState.completedSets));

    const standings = await getStandings(tid);
    check("16 standings rows", standings.length === 16, String(standings.length));
    for (const grp of g) {
      const rows = standings.filter((s) => s.group_id === grp.id).sort((a, b) => a.rank - b.rank);
      const tiesWon = rows.map((r) => r.won);
      check(`${grp.group_name}: ranked on ties won, 6 shared out, rubbers recorded`, tiesWon.reduce((a, b) => a + b, 0) === 6 && tiesWon.every((w, i) => i === 0 || w <= tiesWon[i - 1]) && rows.every((r) => (r.rubbers_won ?? 0) + (r.rubbers_lost ?? 0) === 9), `${tiesWon.join(",")} · rubbers ${rows.map((r) => r.rubbers_won).join(",")}`);
    }
    const leaderboard = await http(`/admin/tournaments/${tid}/leaderboard`);
    check("the leaderboard renders", leaderboard.status === 200, String(leaderboard.status));
    const tiesPage = await http(`/admin/tournaments/${tid}/ties`);
    check("the Ties page renders all 24 group ties", tiesPage.status === 200 && (tiesPage.text.match(/data-testid="tie-card"/g) ?? []).length === 24, String(tiesPage.status));

    phase("Placement draws");
    const drawn = await drawPlacement(tid, "e2e");
    check("placement draws made: 24 ties", drawn.ok && drawn.ties === 24, drawn.ok ? String(drawn.ties) : drawn.message);
    const again = await drawPlacement(tid, "e2e");
    check("drawing twice is refused", !again.ok);
    ties = await getTies(tid);
    const rankOf = new Map(standings.map((s) => [s.team_id, { rank: s.rank, group: g.findIndex((x) => x.id === s.group_id) }]));
    const label = (id: string | null) => (id ? `${"ABCD"[rankOf.get(id)!.group]}${rankOf.get(id)!.rank}` : "?");
    const qf = ties.filter((x) => x.stage === "placement" && x.round_no === 1 && x.draw_from === 1).sort((a, b) => a.tie_order - b.tie_order);
    check("1st–8th round one: A1 v C2, D2 v B1, C1 v A2, B2 v D1", qf.map((x) => `${label(x.team_a_id)}-${label(x.team_b_id)}`).join(" ") === "A1-C2 D2-B1 C1-A2 B2-D1", qf.map((x) => `${label(x.team_a_id)}-${label(x.team_b_id)}`).join(" "));
    const low = ties.filter((x) => x.stage === "placement" && x.round_no === 1 && x.draw_from === 9);
    check("9th–16th round one has the 3rd and 4th placed nations", low.every((x) => [3, 4].includes(rankOf.get(x.team_a_id!)!.rank) && [3, 4].includes(rankOf.get(x.team_b_id!)!.rank)));
    const groupLock = await generateGroupMatches(tid, "e2e").then(() => "regenerated", (e: Error) => e.message);
    check("the group stage is locked once the placement draws exist", groupLock.includes("locked"), groupLock);

    phase("Placement play");
    let placementRounds = 0;
    let droppedDoubles = 0;
    let undoTested = false;
    for (let round = 1; round <= 3; round++) {
      placementRounds++;
      ties = await getTies(tid);
      const roundTies = ties.filter((x) => x.stage === "placement" && x.round_no === round);
      check(`round ${round}: all ${roundTies.length} ties know both nations`, roundTies.every((x) => x.team_a_id && x.team_b_id));
      for (const tie of roundTies) await nominate(tie);
      matches = await getMatches(tid);
      for (const tie of roundTies) {
        const rs = matches.filter((m) => m.tie_id === tie.id).sort((a, b) => a.rubber_no! - b.rubber_no!);
        const fav: TeamKey = seedOf(tie.team_a_id!) < seedOf(tie.team_b_id!) ? "A" : "B";
        const dog: TeamKey = fav === "A" ? "B" : "A";
        const viaHttp = round === 1 && tie.tie_order === Math.min(...roundTies.map((x) => x.tie_order));
        if (viaHttp) {
          // Through the referee API: 2-0, the doubles drops, then an undo of the
          // deciding rubber reopens the tie and brings the doubles back.
          await finishHttp(t, rs[0], fav);
          const decider = await finishHttp(t, rs[1], fav);
          let now = (await getTies(tid)).find((x) => x.id === tie.id)!;
          const d = (await getMatches(tid)).find((m) => m.id === rs[2].id)!;
          check("placement tie decided at 2-0 on referee phones; the doubles is dropped", now.status === "completed" && d.status === "cancelled", `${now.status} / doubles ${d.status}`);
          const next = (await getTies(tid)).find((x) => x.id === now.winner_to_tie_id)!;
          const winnerId = fav === "A" ? tie.team_a_id : tie.team_b_id;
          check("…and the winner is placed in the next round", [next.team_a_id, next.team_b_id].includes(winnerId));
          // Undo the match point of the deciding singles.
          const final = decider.trail[decider.trail.length - 1];
          await decider.post("UNDO", final, decider.trail[decider.trail.length - 2], null);
          now = (await getTies(tid)).find((x) => x.id === tie.id)!;
          const dBack = (await getMatches(tid)).find((m) => m.id === rs[2].id)!;
          const nextBack = (await getTies(tid)).find((x) => x.id === tie.winner_to_tie_id)!;
          check("an undo of the deciding point reopens the tie and brings the doubles back", now.status === "live" && !now.winner_team_id && dBack.status === "scheduled", `${now.status} / doubles ${dBack.status}`);
          check("…and takes the nation back out of the next round", ![nextBack.team_a_id, nextBack.team_b_id].includes(winnerId));
          // Replay the last point and confirm again.
          await decider.post("POINT_AWARDED", decider.trail[decider.trail.length - 2], final, null);
          await decider.post("MATCH_ENDED", final, final, winnerId, { winner_team_id: winnerId });
          undoTested = true;
          droppedDoubles++;
          continue;
        }
        for (const r of rs) {
          const live = (await getMatches(tid)).find((m) => m.id === r.id)!;
          if (live.status === "cancelled") {
            droppedDoubles++;
            continue;
          }
          const w = r.rubber_type === "S2" && rand() < 0.35 ? dog : fav;
          await finishDirect(t, live, w);
        }
      }
    }
    ties = await getTies(tid);
    const placement = ties.filter((x) => x.stage === "placement");
    check("every placement tie finished in three rounds", placement.every((x) => x.status === "completed") && placementRounds === 3, placement.filter((x) => x.status !== "completed").length + " open");
    check("dead doubles were dropped in the placement ties", droppedDoubles > 0, `${droppedDoubles} dropped`);
    check("the undo path ran", undoTested);

    // A decided rubber cannot be reopened once the next tie has started.
    const played = placement.find((x) => x.round_no === 1 && x.winner_to_tie_id)!;
    const deciding = (await getMatches(tid)).filter((m) => m.tie_id === played.id && m.status === "completed" && m.winner_team_id === played.winner_team_id).sort((a, b) => b.rubber_no! - a.rubber_no!)[0];
    const devId = `late-${randomUUID()}`;
    await db().from("scoring_leases").delete().eq("match_id", deciding.id);
    await http(`/api/matches/${deciding.id}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: devId }) }, "referee");
    const { data: snapRow } = await db().from("match_score_snapshots").select("snapshot_json, last_event_number").eq("match_id", deciding.id).single();
    const st = snapRow!.snapshot_json as ScoreState;
    const reopen = await http(
      `/api/matches/${deciding.id}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: devId,
          events: [{ client_event_id: randomUUID(), event_number: snapRow!.last_event_number + 1, event_type: "UNDO", team_id: null, previous_state: st, new_state: { ...st, matchOver: false, winner: null }, payload: null, created_at_client: new Date().toISOString() }],
        }),
      },
      "referee",
    );
    check("reopening a deciding rubber after the next tie has started is refused", reopen.status === 409 && reopen.text.includes("next tie"), `${reopen.status} ${reopen.text.slice(0, 90)}`);

    phase("Final places");
    const places = await finalPlacings(tid);
    check("every place from 1st to 16th decided once", places.length === 16 && places.every((p, i) => p.place === i + 1), places.map((p) => p.place).join(","));
    check("…each nation exactly once", new Set(places.map((p) => p.team_id)).size === 16);
    const champion = teamBy.get(places[0].team_id)!;
    console.log(`   Champion: ${champion.team_name}. Top four: ${places.slice(0, 4).map((p) => teamBy.get(p.team_id)!.nation_code).join(", ")}`);
    const finalPage = await http(`/admin/tournaments/${tid}/ties`);
    check("the Ties page shows the final places", finalPage.status === 200 && finalPage.text.includes('data-testid="final-placings"'));
    for (const p of ["", "/matches", "/leaderboard", "/live"]) {
      const r = await fetch(`${BASE_URL}/t/${t.slug}${p}`);
      check(`public /t/…${p || "/"} renders`, r.status === 200, String(r.status));
    }
  } catch (e) {
    check("the run finished", false, e instanceof Error ? e.stack ?? e.message : String(e));
  } finally {
    await db().from("tournaments").delete().eq("id", tid);
    const { count } = await db().from("ties").select("id", { count: "exact", head: true }).eq("tournament_id", tid);
    const { count: m } = await db().from("matches").select("id", { count: "exact", head: true }).eq("tournament_id", tid);
    check("cleanup removed everything", (count ?? 0) === 0 && (m ?? 0) === 0);
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
