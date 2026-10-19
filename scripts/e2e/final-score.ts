/**
 * Final-result entry (plan Phase 2), end to end on the stand-in: a result typed
 * in one go (RESULT_ENTERED) through the events route and the admin's server
 * action must count exactly like a match scored point by point.
 *
 *   1. Group: standings from an entered result; result confirmation does not hold
 *      it; a bad score, a client state that differs, unknown fields and a
 *      point-by-point match are refused (400, typed problems) with nothing written.
 *   2. A partly scored match replaced by a result: an audited correction, the
 *      earlier events superseded. Only the organiser's staff correct: a referee
 *      code is refused (409 organiser_only) on a partly scored or finished match.
 *   3. Correction of a finished group match by the organiser (server action):
 *      standings follow, audit row with the old result.
 *   4. Knockout: the winner advances; a correction (organiser) moves the new winner
 *      into the next round; once the next round has started the correction is refused.
 *      A session drawn as a knockout does the same (L4), and a Mexicano result is
 *      frozen once the next round is drawn from it.
 *   5. Friendly session: ledger points from an entered result; a correction
 *      replaces them (no duplicates, the other pair now ahead).
 *   6. Chess: a knockout draw is recorded level (live, needsArbiter); a referee
 *      cannot pick who advances, neither as a result nor by ending the match with a
 *      winner of its own; the organiser does (decideWinner); a chess draw
 *      outside a knockout is refused (draws do not count in any table yet).
 *   7. Another organisation's referee (event code) and admin are refused.
 *
 * Stand-in only; creates and deletes its own data.
 *
 *   LOCALDB_PORT=54331 npm run localdb                        # terminal 1
 *   npm run build                                             # no `next dev` running
 *   (set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3087 npx next start -p 3087)
 *   npm run e2e:final-score
 */
import { createHash, randomBytes, randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { db } from "../../src/lib/supabase";
import { createFriendlySession, addEntryForProfile, generateNextMexicanoRound, generateSchedule, generateSessionKnockout, setFixedPairs } from "../../src/lib/friendly/ops";
import { getTournament } from "../../src/lib/data";
import { awardPoint, initialScoreState, type ScoreState } from "../../src/lib/scoring/engine";
import { matchTiebreakSet, stateFromFinalScore, type EnteredSet } from "../../src/lib/scoring/finalScore";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { chessStateFromResults, type ChessGameResult } from "../../src/lib/chess/result";
import { newTournamentMatchDayRules } from "../../src/lib/matchday/rules";
import { generateEventCode, hashEventCode } from "../../src/lib/orgs/codes";
import { DEFAULT_SCORING_CONFIG, type Match, type MatchRules } from "../../src/lib/types";
import { resultPayloadOf, resultRejection } from "../../src/lib/offline/finalResult";
import { sameState } from "../../src/lib/scoring/eventGuard";
import { BASE_URL, sessionToken, staffToken } from "./lib/session";
import { refereeCodeToken } from "./lib/fixtures";

const SUPA = process.env.SUPABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(SUPA)) throw new Error("final-score.ts runs against the local stand-in only");
if (!process.env.STAFF_SESSION_SECRET) throw new Error("STAFF_SESSION_SECRET must be set (the server's, in .env.localdb)");

let failed = 0;
let passed = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail !== undefined && (!ok || process.env.VERBOSE) ? ` — ${typeof detail === "string" ? detail.slice(0, 400) : JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
const section = (s: string) => console.log(`\n— ${s}`);

const cookie = (token: string): Record<string, string> => ({ Cookie: `mb_session=${token}` });
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const REFEREE = cookie(sessionToken("referee"));
const ADMIN = cookie(sessionToken("admin"));

async function http(method: string, path: string, who: Record<string, string>, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    redirect: "manual",
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, text, json };
}

/* ---------------- server actions, called the way the browser does ---------------- */

interface ManifestEntry {
  filename: string;
  exportedName: string;
  workers: Record<string, unknown>;
}
const manifest = JSON.parse(readFileSync(join(process.cwd(), ".next/server/server-reference-manifest.json"), "utf8")) as { node: Record<string, ManifestEntry> };
const RESULT_ACTION_FILE = "src/app/admin/tournaments/[id]/matches/actions.ts";

async function enterMatchResult(tournamentId: string, matchId: string, payload: unknown, who: Record<string, string>) {
  // Paths are relative to the build root ("src/app/…", or with a prefix when the root sits above the checkout).
  const sameFile = (f: string) => f === RESULT_ACTION_FILE || f.endsWith(`/${RESULT_ACTION_FILE}`) || `src/${f}` === RESULT_ACTION_FILE;
  const hit = Object.entries(manifest.node).find(([, e]) => sameFile(e.filename) && e.exportedName === "enterMatchResult");
  if (!hit) throw new Error("enterMatchResult is not in the build manifest (rebuild?)");
  const res = await fetch(`${BASE_URL}/admin/tournaments/${tournamentId}/matches`, {
    method: "POST",
    headers: { "Next-Action": hit[0], Accept: "text/x-component", Origin: BASE_URL, "Content-Type": "text/plain;charset=UTF-8", ...who },
    body: JSON.stringify([tournamentId, matchId, payload]),
    redirect: "manual",
  });
  const text = await res.text();
  // The RSC reply's last line carries the action's return value.
  const value = text
    .split("\n")
    .map((l) => l.replace(/^[0-9a-f]+:/, ""))
    .map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return null;
      }
    })
    .find((v): v is { ok: boolean; error?: string; problems?: { code: string }[] } => !!v && typeof v === "object" && "ok" in (v as object));
  return { status: res.status, text, value: value ?? null };
}

/* ---------------- scoring helpers ---------------- */

async function lastEvent(matchId: string): Promise<{ n: number; state: unknown }> {
  const { data } = await db().from("match_score_snapshots").select("last_event_number, snapshot_json").eq("match_id", matchId).maybeSingle();
  const s = data as { last_event_number: number; snapshot_json: unknown } | null;
  return { n: s?.last_event_number ?? 0, state: s?.snapshot_json ?? null };
}

function ev(n: number, type: string, prev: unknown, next: unknown, extra: { team_id?: string | null; payload?: Record<string, unknown> | null } = {}) {
  return {
    client_event_id: randomUUID(),
    event_number: n,
    event_type: type,
    team_id: extra.team_id ?? null,
    previous_state: prev,
    new_state: next,
    payload: extra.payload ?? null,
    created_at_client: new Date().toISOString(),
  };
}

async function send(matchId: string, who: Record<string, string>, events: unknown[], deviceId = `e2e-fs-${randomUUID().slice(0, 8)}`) {
  return http("POST", `/api/matches/${matchId}/events`, who, { deviceId, events });
}

function built(rules: MatchRules, sets: EnteredSet[]): ScoreState {
  const r = stateFromFinalScore(rules, sets);
  if (!r.ok) throw new Error(`test fixture: ${JSON.stringify(r.problems)}`);
  return r.state;
}

/** A RESULT_ENTERED from a scoring device, built the way a client builds it. */
async function sendResult(match: Match, rules: MatchRules, sets: EnteredSet[], who: Record<string, string>, opts: { state?: unknown; payload?: Record<string, unknown> } = {}) {
  const { n, state: prev } = await lastEvent(match.id);
  const state = opts.state ?? built(rules, sets);
  const winner = (state as ScoreState).winner === "A" ? match.team_a_id : match.team_b_id;
  return send(match.id, who, [ev(n + 1, "RESULT_ENTERED", prev, state, { team_id: winner, payload: opts.payload ?? { sets } })]);
}

async function matchRow(id: string): Promise<Match & { result_source: string | null }> {
  const { data } = await db().from("matches").select("*").eq("id", id).single();
  return data as Match & { result_source: string | null };
}

async function eventCount(matchId: string): Promise<number> {
  const { count } = await db().from("score_events").select("id", { count: "exact", head: true }).eq("match_id", matchId);
  return count ?? 0;
}

async function standing(tournamentId: string, teamId: string) {
  const { data } = await db().from("standings_snapshots").select("*").eq("tournament_id", tournamentId).eq("team_id", teamId).maybeSingle();
  return data as { played: number; won: number; lost: number; points: number; sets_won: number; sets_lost: number; games_won: number; games_lost: number } | null;
}

async function auditRows(matchId: string, action: string) {
  const { data } = await db().from("audit_logs").select("action, old_value, new_value, actor_role").eq("entity_id", matchId).eq("action", action);
  return (data ?? []) as { action: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null; actor_role: string }[];
}

const codeOf = (r: { json: Record<string, unknown> | null }) => ((r.json?.problems as { code: string }[] | undefined) ?? [])[0]?.code;

/* ---------------- the stand-in's Supabase Auth (another organisation's admin) ---------------- */

async function standinUser(email: string): Promise<string> {
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const a = await fetch(
    `${SUPA}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent("http://localhost/e2e")}&code_challenge=${challenge}&code_challenge_method=s256&login_hint=${encodeURIComponent(email)}`,
    { redirect: "manual" },
  );
  const code = new URL(a.headers.get("location")!).searchParams.get("code");
  const t = await fetch(`${SUPA}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  return ((await t.json()) as { user: { id: string } }).user.id;
}

/* ---------------- fixtures ---------------- */

async function main() {
  const tag = randomUUID().slice(0, 6);
  const created = { tournaments: [] as string[], sessions: [] as string[], profiles: [] as string[], orgs: [] as string[] };

  try {
    // Best of three, match tie-break at one set all; results need confirming (a
    // result entered in one go is confirmed on entry, so it must not wait).
    const rulesConfig = { ...DEFAULT_SCORING_CONFIG, setsToWinMatch: 2, matchTiebreak: true, matchTiebreakPoints: 10, requireResultConfirmation: true };
    const { data: tRow } = await db()
      .from("tournaments")
      .insert({ name: `E2E Final Score ${tag}`, slug: `e2e-final-score-${tag}`, sport: "padel", status: "active", is_demo: true, scoring_config: rulesConfig, match_day_rules: newTournamentMatchDayRules("padel") })
      .select("id")
      .single();
    const T = (tRow as { id: string }).id;
    created.tournaments.push(T);
    const { data: teamRows } = await db()
      .from("teams")
      .insert(["One", "Two", "Three", "Four"].map((n) => ({ tournament_id: T, team_name: `FS ${n} ${tag}` })))
      .select("id, team_name");
    const teams = (teamRows as { id: string; team_name: string }[]).sort((a, b) => a.team_name.localeCompare(b.team_name));
    const byName = (n: string) => teams.find((t) => t.team_name.startsWith(`FS ${n}`))!.id;
    const [t1, t2, t3, t4] = [byName("One"), byName("Two"), byName("Three"), byName("Four")];
    const { data: g } = await db().from("groups").insert({ tournament_id: T, group_name: "A", status: "published" }).select("id").single();
    const G = (g as { id: string }).id;
    await db().from("group_teams").insert([t1, t2, t3].map((team_id, i) => ({ tournament_id: T, group_id: G, team_id, position: i + 1 })));
    const groupMatch = async (a: string, b: string, order: number) =>
      (
        (await db()
          .from("matches")
          .insert({ tournament_id: T, stage: "group", group_id: G, round_name: "Group A", match_order: order, team_a_id: a, team_b_id: b, status: "scheduled" })
          .select("*")
          .single()).data as Match
      );
    const g1 = await groupMatch(t1, t2, 1);
    const g2 = await groupMatch(t1, t3, 2);
    const g3 = await groupMatch(t2, t3, 3);
    const t = await getTournament(T);
    const groupRules = scoringConfigForMatch(t, { stage: "group" });

    section("1. a group result entered in one go");
    {
      const r = await sendResult(g1, groupRules, [{ a: 6, b: 4 }, { a: 7, b: 6, tb: { a: 7, b: 5 } }], REFEREE);
      check(r.status === 200, "the referee's result is accepted", r.text);
      const m = await matchRow(g1.id);
      check(m.status === "completed" && m.winner_team_id === t1, "the match is completed with the entered winner, though results need confirming", `${m.status} ${m.winner_team_id === t1}`);
      check(m.result_source === "final_score", "result_source is final_score", m.result_source);
      const s1 = await standing(T, t1);
      const s2 = await standing(T, t2);
      check(s1?.won === 1 && s1.points === 1 && s1.sets_won === 2 && s1.sets_lost === 0 && s1.games_won === 13 && s1.games_lost === 10, "standings count it like a scored match (sets 2-0, games 13-10)", s1);
      check(s2?.lost === 1 && s2.points === 0, "…and the loser's row too", s2);
      const { data: stored } = await db().from("score_events").select("event_type, sync_status, new_state_json").eq("match_id", g1.id);
      const row = (stored ?? [])[0] as { event_type: string; new_state_json: ScoreState } | undefined;
      check(row?.event_type === "RESULT_ENTERED" && row.new_state_json.matchOver === true, "the event is stored with the server-built state");
      check((await auditRows(g1.id, "RESULT_ENTERED")).length === 1, "an audit row records who entered it");
    }

    section("refusals: nothing is written");
    {
      const before = await eventCount(g2.id);
      const noTb = await sendResult(g2, groupRules, [{ a: 7, b: 6 }, { a: 6, b: 2 }], REFEREE, { state: built(groupRules, [{ a: 7, b: 6, tb: { a: 7, b: 1 } }, { a: 6, b: 2 }]) });
      check(noTb.status === 400 && noTb.json?.code === "final_score" && codeOf(noTb) === "tiebreak_required", "a 7-6 set without its tie-break points is a 400 tiebreak_required", noTb.text);
      const badTb = await sendResult(g2, groupRules, [{ a: 7, b: 6, tb: { a: 7, b: 6 } }, { a: 6, b: 2 }], REFEREE, { state: built(groupRules, [{ a: 6, b: 1 }, { a: 6, b: 2 }]) });
      check(badTb.status === 400 && codeOf(badTb) === "tiebreak_score", "a tie-break that is not finished is a 400 tiebreak_score", badTb.text);
      const impossible = await sendResult(g2, groupRules, [{ a: 6, b: 5 }, { a: 6, b: 2 }], REFEREE, { state: built(groupRules, [{ a: 6, b: 1 }, { a: 6, b: 2 }]) });
      check(impossible.status === 400 && codeOf(impossible) === "set_score", "6-5 is a 400 set_score", impossible.text);
      const mismatch = await sendResult(g2, groupRules, [{ a: 6, b: 4 }, { a: 6, b: 2 }], REFEREE, { state: built(groupRules, [{ a: 6, b: 4 }, { a: 6, b: 3 }]) });
      check(mismatch.status === 400 && codeOf(mismatch) === "state_mismatch", "a client state that differs from the server's is a 400 state_mismatch", mismatch.text);
      const extra = await sendResult(g2, groupRules, [{ a: 6, b: 4 }, { a: 6, b: 2 }], REFEREE, { payload: { sets: [{ a: 6, b: 4 }, { a: 6, b: 2 }], winner: "A" } });
      check(extra.status === 400 && codeOf(extra) === "payload", "unknown payload fields are a 400 payload", extra.text);
      {
        // A phone's queued result that slipped past its own check: the 400 names it, so the
        // phone takes it (and what followed) out of its queue and fills the form in again.
        const { n, state: prev } = await lastEvent(g2.id);
        const queued = ev(n + 1, "RESULT_ENTERED", prev, built(groupRules, [{ a: 6, b: 1 }, { a: 6, b: 2 }]), { team_id: g2.team_a_id, payload: { sets: [{ a: 6, b: 5 }, { a: 6, b: 2 }] } });
        const after = ev(n + 2, "MATCH_ENDED", null, built(groupRules, [{ a: 6, b: 1 }, { a: 6, b: 2 }]));
        const r = await send(g2.id, REFEREE, [queued, after]);
        const rej = resultRejection([queued, after], r.status, r.json);
        check(
          r.status === 400 && rej?.drop.map((e) => e.client_event_id).join() === [queued.client_event_id, after.client_event_id].join() && rej.problems[0]?.code === "set_score" && JSON.stringify(resultPayloadOf(rej.result)) === JSON.stringify({ sets: [{ a: 6, b: 5 }, { a: 6, b: 2 }] }),
          "a refused queued result is named: the phone drops it with what followed and refills the form",
          r.text,
        );
      }
      await db().from("matches").update({ scoring_mode_override: "point_by_point" }).eq("id", g2.id);
      const mode = await sendResult(g2, groupRules, [{ a: 6, b: 4 }, { a: 6, b: 2 }], REFEREE);
      check(mode.status === 400 && codeOf(mode) === "mode", "a match recorded point by point refuses a final result", mode.text);
      await db().from("matches").update({ scoring_mode_override: null }).eq("id", g2.id);
      const m = await matchRow(g2.id);
      check((await eventCount(g2.id)) === before && m.status === "scheduled", "nothing was written by any refusal", `${await eventCount(g2.id)} ${m.status}`);
    }

    section("2. a partly scored match replaced by a result");
    {
      const device = `e2e-fs-dev-${tag}`;
      let s = initialScoreState("A");
      const events = [ev(1, "MATCH_STARTED", null, s, { payload: { first_server: "A" } })];
      for (let i = 0; i < 3; i++) {
        const next = awardPoint(s, "A", groupRules);
        events.push(ev(i + 2, "POINT_AWARDED", s, next, { team_id: t1 }));
        s = next;
      }
      const started = await send(g2.id, REFEREE, events, device);
      check(started.status === 200, "points are scored first", started.text);
      const sets: EnteredSet[] = [{ a: 2, b: 6 }, { a: 1, b: 6 }];
      const byRef = await send(g2.id, REFEREE, [ev(5, "RESULT_ENTERED", s, built(groupRules, sets), { team_id: t3, payload: { sets } })], device);
      check(byRef.status === 409 && byRef.json?.conflict === "organiser_only" && (await eventCount(g2.id)) === 4, "a referee cannot replace points already scored with a result (the organiser's correction)", byRef.text);
      const res = await send(g2.id, ADMIN, [ev(5, "RESULT_ENTERED", s, built(groupRules, sets), { team_id: t3, payload: { sets } })], device);
      check(res.status === 200, "the organiser's result replaces them", res.text);
      const m = await matchRow(g2.id);
      check(m.status === "completed" && m.winner_team_id === t3 && m.result_source === "correction", "completed, the result's winner, result_source correction", `${m.status} ${m.result_source}`);
      const { data: rows } = await db().from("score_events").select("event_number, sync_status").eq("match_id", g2.id).order("event_number");
      const r = (rows ?? []) as { event_number: number; sync_status: string }[];
      check(r.filter((x) => x.event_number < 5).every((x) => x.sync_status === "superseded") && r.find((x) => x.event_number === 5)?.sync_status === "synced", "the earlier events are marked superseded, the result is not", r);
      const audits = await auditRows(g2.id, "RESULT_CORRECTED");
      check(audits.length === 1 && audits[0].old_value?.superseded_through_event === 4, "an audit row records the correction and what it superseded", audits[0]?.old_value);
      const s3 = await standing(T, t3);
      check(s3?.won === 1 && s3.games_won === 12, "standings count the entered result, not the replaced points", s3);
    }

    section("3. the organiser corrects a finished match (server action)");
    {
      const bad = await enterMatchResult(T, g1.id, { sets: [{ a: 6, b: 6 }] }, ADMIN);
      check(bad.value?.ok === false && bad.value.problems?.[0]?.code === "set_score", "a bad score comes back as problems, nothing written", bad.text.slice(-300));
      const r = await enterMatchResult(T, g1.id, { sets: [{ a: 3, b: 6 }, { a: 4, b: 6 }] }, ADMIN);
      check(r.status === 200 && r.value?.ok === true, "the admin's correction is recorded", r.text.slice(-300));
      const m = await matchRow(g1.id);
      check(m.status === "completed" && m.winner_team_id === t2 && m.result_source === "correction", "the match now has the corrected winner, result_source correction", `${m.winner_team_id === t2} ${m.result_source}`);
      const s1 = await standing(T, t1);
      const s2 = await standing(T, t2);
      check(s2?.won === 1 && s2.points === 1 && s2.games_won === 12 && s1?.won === 0 && s1.lost === 2 && s1.points === 0, "standings follow the correction (Two won g1; One has lost both)", { s1, s2 });
      const audits = await auditRows(g1.id, "RESULT_CORRECTED");
      check(
        audits.length === 1 && audits[0].old_value?.winner_team_id === t1 && audits[0].old_value?.status === "completed",
        "the audit row keeps the old result",
        audits[0]?.old_value,
      );
    }

    section("4. knockout: advancement and corrections");
    {
      const { data: b } = await db().from("brackets").insert({ tournament_id: T, status: "published", tier: "cup" }).select("id").single();
      const B = (b as { id: string }).id;
      const ko = async (stage: string, round: string, a: string | null, bb: string | null, order: number) =>
        (
          (await db()
            .from("matches")
            .insert({ tournament_id: T, stage, round_name: round, match_order: order, team_a_id: a, team_b_id: bb, status: "scheduled", bracket_id: B })
            .select("*")
            .single()).data as Match
        );
      const sf1 = await ko("semi_final", "Semi-final 1", t1, t4, 10);
      const sf2 = await ko("semi_final", "Semi-final 2", t2, t3, 11);
      const fin = await ko("final", "Final", null, null, 12);
      await db().from("bracket_slots").insert([
        { bracket_id: B, tournament_id: T, round_name: "SF", slot_order: 0, match_id: sf1.id, team_id: t1 },
        { bracket_id: B, tournament_id: T, round_name: "SF", slot_order: 1, match_id: sf1.id, team_id: t4 },
        { bracket_id: B, tournament_id: T, round_name: "SF", slot_order: 2, match_id: sf2.id, team_id: t2 },
        { bracket_id: B, tournament_id: T, round_name: "SF", slot_order: 3, match_id: sf2.id, team_id: t3 },
        { bracket_id: B, tournament_id: T, round_name: "F", slot_order: 0, match_id: fin.id },
        { bracket_id: B, tournament_id: T, round_name: "F", slot_order: 1, match_id: fin.id },
      ]);
      const koRules = scoringConfigForMatch(t, sf1, "cup");
      const r1 = await sendResult(sf1, koRules, [{ a: 6, b: 2 }, { a: 6, b: 3 }], REFEREE);
      check(r1.status === 200, "a semi-final result is accepted", r1.text);
      check((await matchRow(fin.id)).team_a_id === t1, "its winner advances to the final");
      const byRef = await sendResult(sf1, koRules, [{ a: 6, b: 2 }, { a: 4, b: 6 }, matchTiebreakSet(8, 10)], REFEREE);
      check(byRef.status === 409 && byRef.json?.conflict === "organiser_only" && (await matchRow(sf1.id)).winner_team_id === t1, "a referee code cannot overwrite the finished semi-final's result", byRef.text);
      const r2 = await sendResult(sf1, koRules, [{ a: 6, b: 2 }, { a: 4, b: 6 }, matchTiebreakSet(8, 10)], ADMIN);
      check(r2.status === 200, "the organiser corrects the finished semi-final (match tie-break 8-10)", r2.text);
      const sf1Now = await matchRow(sf1.id);
      check(sf1Now.winner_team_id === t4 && sf1Now.result_source === "correction", "the semi-final has the new winner", sf1Now.result_source);
      const finNow = await matchRow(fin.id);
      check(finNow.team_a_id === t4, "the final now has the corrected winner, not the old one", finNow.team_a_id === t1 ? "still the old winner" : String(finNow.team_a_id));
      const { data: slot } = await db().from("bracket_slots").select("team_id").eq("bracket_id", B).eq("round_name", "F").eq("slot_order", 0).single();
      check((slot as { team_id: string }).team_id === t4, "…and so does its bracket slot");
      await db().from("matches").update({ status: "live" }).eq("id", fin.id);
      const r3 = await sendResult(sf1, koRules, [{ a: 6, b: 0 }, { a: 6, b: 0 }], ADMIN);
      check(r3.status === 409 && r3.json?.conflict === "downstream_started", "once the final has started, the semi-final cannot be corrected", r3.text);
      check((await matchRow(sf1.id)).winner_team_id === t4 && (await matchRow(fin.id)).team_a_id === t4, "…and nothing changed");
    }

    section("5. friendly session: ledger points");
    {
      const { data: profiles } = await db()
        .from("player_profiles")
        .insert(["Amr", "Basma", "Cyrine", "Dalia"].map((n) => ({ public_name: `${n} FS ${tag}`, approval_status: "approved" })))
        .select("id");
      const pids = (profiles as { id: string }[]).map((p) => p.id);
      created.profiles.push(...pids);
      const session = await createFriendlySession({
        name: `E2E Final Score Night ${tag}`,
        seasonId: null,
        startsAt: null,
        durationMinutes: null,
        scoringMode: "final_score",
        courtCount: 1,
        pairingMode: "americano",
        rankingModel: "win_points",
        setsToWinMatch: 1,
        gamesToWinSet: 6,
        maxPlayers: null,
        registrationDeadline: null,
        actorRole: "e2e",
      });
      created.sessions.push(session.id);
      created.tournaments.push(session.tournament_id);
      for (const p of pids) await addEntryForProfile(session.id, p, "e2e");
      await generateSchedule(session.id, "e2e", { fit: "all" });
      const { data: sm } = await db().from("matches").select("*").eq("tournament_id", session.tournament_id).order("match_order").limit(1).single();
      const fm = sm as Match;
      const { data: parts } = await db().from("friendly_match_participants").select("*").eq("match_id", fm.id).single();
      const p = parts as { team_a_player_one: string; team_a_player_two: string; team_b_player_one: string; team_b_player_two: string };
      const sideA = [p.team_a_player_one, p.team_a_player_two];
      const sideB = [p.team_b_player_one, p.team_b_player_two];
      const st = await getTournament(session.tournament_id);
      const fRules = scoringConfigForMatch(st, fm);
      const totals = async () => {
        const { data } = await db().from("player_score_ledger").select("player_profile_id, component, points").eq("match_id", fm.id);
        const rows = (data ?? []) as { player_profile_id: string; component: string; points: number }[];
        const sum = (ids: string[]) => rows.filter((r) => ids.includes(r.player_profile_id)).reduce((n, r) => n + r.points, 0);
        const keys = rows.map((r) => `${r.player_profile_id}|${r.component}`);
        return { a: sum(sideA), b: sum(sideB), rows: rows.length, unique: new Set(keys).size === keys.length };
      };
      const r1 = await sendResult(fm, fRules, [{ a: 6, b: 3 }], REFEREE);
      check(r1.status === 200, "a referee enters a session match's result", r1.text);
      const t1Points = await totals();
      check(t1Points.rows > 0 && t1Points.a > t1Points.b, "the winning pair gets the ledger points", t1Points);
      const byRef = await sendResult(fm, fRules, [{ a: 2, b: 6 }], REFEREE);
      check(byRef.status === 409 && byRef.json?.conflict === "organiser_only", "the referee cannot change the recorded result", byRef.text);
      const r2 = await sendResult(fm, fRules, [{ a: 2, b: 6 }], ADMIN);
      check(r2.status === 200, "the organiser corrects it", r2.text);
      const t2Points = await totals();
      check(t2Points.b > t2Points.a && t2Points.unique && t2Points.b === t1Points.a, "the points move to the other pair, no duplicates left behind", t2Points);
      check((await matchRow(fm.id)).result_source === "correction", "result_source correction");
    }

    section("5b. sessions: a knockout's later round and Mexicano's next round (L4)");
    {
      const people = async (n: number, label: string) => {
        const { data } = await db()
          .from("player_profiles")
          .insert(Array.from({ length: n }, (_, i) => ({ public_name: `${label} ${i} ${tag}`, approval_status: "approved" })))
          .select("id");
        const ids = (data as { id: string }[]).map((p) => p.id);
        created.profiles.push(...ids);
        return ids;
      };
      const newSession = async (name: string, pairingMode: "fixed" | "mexicano") => {
        const s = await createFriendlySession({
          name: `${name} ${tag}`,
          seasonId: null,
          startsAt: null,
          durationMinutes: null,
          scoringMode: "final_score",
          courtCount: 2,
          pairingMode,
          rankingModel: "win_points",
          setsToWinMatch: 1,
          gamesToWinSet: 6,
          maxPlayers: null,
          registrationDeadline: null,
          actorRole: "e2e",
        });
        created.sessions.push(s.id);
        created.tournaments.push(s.tournament_id);
        return s;
      };

      // A session drawn as a knockout: its matches carry stage 'friendly', yet its later round follows a correction.
      const ko = await newSession("E2E Session Knockout", "fixed");
      const kp = await people(8, "KO");
      for (const p of kp) await addEntryForProfile(ko.id, p, "e2e");
      await setFixedPairs(ko.id, [[kp[0], kp[1]], [kp[2], kp[3]], [kp[4], kp[5]], [kp[6], kp[7]]], "e2e");
      await generateSessionKnockout(ko.id, "e2e");
      const { data: kSlots } = await db().from("bracket_slots").select("round_name, slot_order, match_id").eq("tournament_id", ko.tournament_id).order("slot_order");
      const slots = (kSlots ?? []) as { round_name: string; slot_order: number; match_id: string | null }[];
      const sfId = slots.find((x) => x.round_name === "SF" && x.slot_order === 0)?.match_id;
      const finId = slots.find((x) => x.round_name === "F")?.match_id;
      check(Boolean(sfId && finId), "the session's knockout has a semi-final and a final", slots.map((x) => x.round_name));
      if (sfId && finId) {
        const sf = await matchRow(sfId);
        check(sf.stage === "friendly", "its matches are stage 'friendly' (relabelled)", sf.stage);
        const kst = await getTournament(ko.tournament_id);
        const kRules = scoringConfigForMatch(kst, sf);
        const r1 = await sendResult(sf, kRules, [{ a: 6, b: 2 }], ADMIN);
        const finSlot = async () => (await db().from("bracket_slots").select("team_id").eq("tournament_id", ko.tournament_id).eq("round_name", "F").eq("slot_order", 0).single()).data as { team_id: string | null };
        check(r1.status === 200 && (await matchRow(finId)).team_a_id === sf.team_a_id && (await finSlot()).team_id === sf.team_a_id, "the semi-final's winner reaches the session's final", r1.text);
        const r2 = await sendResult(sf, kRules, [{ a: 2, b: 6 }], ADMIN);
        check(r2.status === 200 && (await matchRow(finId)).team_a_id === sf.team_b_id && (await finSlot()).team_id === sf.team_b_id, "a correction moves the new winner into the final (the old one is taken back)", r2.text);
        await db().from("matches").update({ status: "live" }).eq("id", finId);
        const r3 = await sendResult(sf, kRules, [{ a: 6, b: 0 }], ADMIN);
        check(r3.status === 409 && r3.json?.conflict === "downstream_started" && (await matchRow(finId)).team_a_id === sf.team_b_id, "once the session's final has started, the semi-final cannot be changed (and the final keeps its sides)", r3.text);
      }

      // Mexicano: each round is paired from the standings after the last one.
      const mx = await newSession("E2E Session Mexicano", "mexicano");
      for (const p of await people(4, "MX")) await addEntryForProfile(mx.id, p, "e2e");
      await generateSchedule(mx.id, "e2e", { fit: "all" });
      const { data: r1Rows } = await db().from("matches").select("*").eq("tournament_id", mx.tournament_id).order("match_order");
      const round1 = (r1Rows ?? []) as Match[];
      const mst = await getTournament(mx.tournament_id);
      const mRules = scoringConfigForMatch(mst, round1[0]!);
      for (const m of round1) await sendResult(m, mRules, [{ a: 6, b: 3 }], ADMIN);
      const before = await sendResult(round1[0]!, mRules, [{ a: 3, b: 6 }], ADMIN);
      check(before.status === 200, "a Mexicano result can be corrected while its round is the last one drawn", before.text);
      await generateNextMexicanoRound(mx.id, "e2e");
      const { count: drawn } = await db().from("friendly_match_participants").select("match_id", { count: "exact", head: true }).eq("session_id", mx.id).eq("round_number", 2);
      check((drawn ?? 0) > 0, "the next round is drawn from the standings", drawn);
      const after = await sendResult(round1[0]!, mRules, [{ a: 6, b: 0 }], ADMIN);
      const kept = await matchRow(round1[0]!.id);
      check(after.status === 409 && after.json?.conflict === "next_round_drawn" && kept.winner_team_id === round1[0]!.team_b_id, "once the next round is drawn from it, the earlier result is frozen (409), unchanged", after.text);
    }

    section("6. chess: win / draw / loss");
    {
      const { data: c } = await db()
        .from("tournaments")
        .insert({ name: `E2E Chess Result ${tag}`, slug: `e2e-chess-result-${tag}`, sport: "chess", status: "active", is_demo: true, format_config: { type: "knockout", legs: 1 }, match_day_rules: newTournamentMatchDayRules("chess") })
        .select("id")
        .single();
      const C = (c as { id: string }).id;
      created.tournaments.push(C);
      const { data: cTeams } = await db().from("teams").insert([{ tournament_id: C, team_name: `White ${tag}` }, { tournament_id: C, team_name: `Black ${tag}` }]).select("id, team_name");
      const [c1, c2] = (cTeams as { id: string; team_name: string }[]).sort((a, b) => b.team_name.localeCompare(a.team_name)).map((x) => x.id);
      const { data: cm } = await db().from("matches").insert({ tournament_id: C, stage: "final", round_name: "Final", match_order: 1, team_a_id: c1, team_b_id: c2, status: "scheduled" }).select("*").single();
      const chessMatch = cm as Match;
      const chessState = (games: ChessGameResult[], competition: "knockout" | "group") => {
        const r = chessStateFromResults(games, { legs: 1, competition });
        if (!r.ok) throw new Error("fixture");
        return r.state;
      };
      const chessDev = `e2e-fs-chess-${tag}`;
      const draw = await send(chessMatch.id, REFEREE, [ev(1, "RESULT_ENTERED", null, chessState(["draw"], "knockout"), { payload: { chess: ["draw"] } })], chessDev);
      check(draw.status === 200, "a referee records a knockout draw", draw.text);
      const afterDraw = await matchRow(chessMatch.id);
      const snap = (await lastEvent(chessMatch.id)).state as { needsArbiter?: boolean; matchOver?: boolean };
      check(afterDraw.status === "live" && !afterDraw.winner_team_id && snap.needsArbiter === true && snap.matchOver === false, "the pairing is level: live, nobody advanced, waiting for the organiser", `${afterDraw.status} ${JSON.stringify(snap)}`);
      const refAdvance = await send(chessMatch.id, REFEREE, [ev(2, "RESULT_ENTERED", snap, { ...chessState(["draw"], "knockout"), winner: "B", matchOver: true, needsArbiter: false }, { team_id: c2, payload: { chess: ["draw"], advance: "B" } })]);
      check(refAdvance.status === 400 && codeOf(refAdvance) === "advance_not_allowed", "a referee cannot pick who advances", refAdvance.text);
      // Nor by ending the level match point by point with a winner of its own (decideWinner's state, or a payload winner).
      const decidedByRef = { ...chessState(["draw"], "knockout"), winner: "B", matchOver: true, needsArbiter: false };
      const refEnd = await send(chessMatch.id, REFEREE, [ev(2, "MATCH_ENDED", snap, decidedByRef, { team_id: c2, payload: { winner_team_id: c2 } })], chessDev);
      const refForce = await send(chessMatch.id, REFEREE, [ev(2, "FORCE_END", snap, snap, { payload: { winner_team_id: c1 } })], chessDev);
      const stillLevel = await matchRow(chessMatch.id);
      check(
        refEnd.status === 409 && refEnd.json?.conflict === "organiser_only" && refForce.status === 409 && refForce.json?.conflict === "organiser_only" && stillLevel.status === "live" && !stillLevel.winner_team_id,
        "a referee cannot end a level pairing with a winner either (MATCH_ENDED or FORCE_END): still live, nobody advanced",
        [refEnd.status, refEnd.json?.conflict, refForce.status, refForce.json?.conflict, stillLevel.status],
      );
      // The device that recorded the draw holds the match; the organiser takes over once it is released.
      await db().from("scoring_leases").delete().eq("match_id", chessMatch.id);
      const decided = await enterMatchResult(C, chessMatch.id, { chess: ["draw"], advance: "B" }, ADMIN);
      check(decided.value?.ok === true, "the organiser decides who advances", decided.text.slice(-300));
      const final = await matchRow(chessMatch.id);
      check(final.status === "completed" && final.winner_team_id === c2, "the match is completed with the organiser's choice", `${final.status}`);
      const decidedState = (await lastEvent(chessMatch.id)).state as { winner?: string; needsArbiter?: boolean; scoreA?: number; scoreB?: number };
      check(decidedState.winner === "B" && decidedState.needsArbiter === false && decidedState.scoreA === 0.5 && decidedState.scoreB === 0.5, "the stored state is decideWinner's (½-½, B advances)", decidedState);
      // The Move Score app's organiser entry (move-score-app/src/referee/chessResult.ts) builds the same state.
      check(sameState({ ...chessState(["draw"], "knockout"), winner: "B", matchOver: true, needsArbiter: false }, decidedState), "the app's organiser result builds exactly the stored state", decidedState);
      const { data: gm } = await db().from("matches").insert({ tournament_id: C, stage: "group", round_name: "Round 1", match_order: 2, team_a_id: c1, team_b_id: c2, status: "scheduled" }).select("*").single();
      const groupDraw = await send((gm as Match).id, REFEREE, [ev(1, "RESULT_ENTERED", null, chessState(["draw"], "group"), { payload: { chess: ["draw"] } })]);
      check(groupDraw.status === 400 && codeOf(groupDraw) === "draw_unsupported", "a chess draw outside a knockout is refused (no table counts draws yet)", groupDraw.text);
      const win = await send((gm as Match).id, REFEREE, [ev(1, "RESULT_ENTERED", null, chessState(["A"], "group"), { team_id: c1, payload: { chess: ["A"] } })]);
      check(win.status === 200 && (await matchRow((gm as Match).id)).winner_team_id === c1, "a chess win outside a knockout is recorded");
    }

    section("7. another organisation is refused");
    {
      const { data: o } = await db().from("organizations").insert({ slug: `e2e-fs-x-${tag}`, name: `E2E FS Other ${tag}`, status: "approved" }).select("id").single();
      const X = (o as { id: string }).id;
      created.orgs.push(X);
      const code = generateEventCode();
      const { data: cr } = await db().from("organization_codes").insert({ organization_id: X, role: "referee", code_hash: hashEventCode(code), label: "e2e" }).select("id").single();
      const xReferee = bearer(await refereeCodeToken({ codeId: (cr as { id: string }).id, orgId: X }));
      const before = await eventCount(g3.id);
      const r = await sendResult(g3, groupRules, [{ a: 6, b: 1 }, { a: 6, b: 1 }], xReferee);
      check(r.status === 404 && !r.text.includes(t2), "another organisation's referee gets a 404 for this match", `${r.status} ${r.text}`);
      const userId = await standinUser(`e2e.fs.x.${tag}@example.com`);
      await db().from("organization_members").insert({ organization_id: X, auth_user_id: userId, invited_email: `e2e.fs.x.${tag}@example.com`, role: "admin", status: "active" });
      const xAdmin = cookie(staffToken({ kind: "member", userId, orgId: X, role: "admin" }));
      const a = await enterMatchResult(T, g3.id, { sets: [{ a: 6, b: 1 }, { a: 6, b: 1 }] }, xAdmin);
      check(a.value?.ok !== true && /"digest"|Not found/.test(a.text), "another organisation's admin is refused by the server action", a.text.slice(0, 300));
      const m = await matchRow(g3.id);
      check((await eventCount(g3.id)) === before && m.status === "scheduled" && !m.winner_team_id, "the match is untouched");
    }
  } finally {
    await db().from("audit_logs").delete().in("tournament_id", created.tournaments);
    await db().from("friendly_entries").delete().in("session_id", created.sessions);
    await db().from("friendly_sessions").delete().in("id", created.sessions);
    await db().from("tournaments").delete().in("id", created.tournaments);
    await db().from("player_profiles").delete().in("id", created.profiles);
    await db().from("organization_codes").delete().in("organization_id", created.orgs);
    await db().from("organization_members").delete().in("organization_id", created.orgs);
    await db().from("audit_logs").delete().in("organization_id", created.orgs);
    await db().from("organizations").delete().in("id", created.orgs);
    const { count } = await db().from("tournaments").select("id", { count: "exact", head: true }).in("id", created.tournaments);
    check((count ?? 0) === 0, "cleaned up");
  }
  console.log(`\n${failed === 0 ? "✅" : "❌"} final-score: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
