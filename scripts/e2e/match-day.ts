/**
 * Match day (plan Phase 3), end to end on the stand-in, alerts in dry run:
 *
 *   1. "Match soon": a side one game from winning tells the players of the next
 *      match on that court (their own wording), once per match — the score coming
 *      back from the brink and crossing again sends nothing more; starred fans hear
 *      nothing (off by default); a phone with court alerts off hears nothing.
 *   2. Not for a next match with a side still to be decided, and not for players
 *      busy on another court.
 *   3. Calling to court: refused while the court is busy; called (status ready,
 *      idempotent); the players alerted; the referee marks one side present; the
 *      reminder goes out through the scheduled drain (the cron route) to the side
 *      still missing only.
 *   4. No-show: the prompt at the deadline, "keep waiting", +5 extensions up to the
 *      maximum, a walkover to the wrong side refused, the walkover to the side
 *      that is here recorded through the scoring path.
 *   5. Opening the match on the referee phone calls it (auto on referee open);
 *      "I'm at court" by the player (only their own match); a QR check-in at the
 *      court by the other side's player marks them present; both present → ready;
 *      MATCH_STARTED closes the call.
 *   6. Both absent: prompt only (no walkover), "wait", withdraw the call.
 *   7. Another organisation's referee is refused on the call route.
 *   8. Phase 2 leftovers: an Undo after an entered result is refused; a corrected
 *      result does not send "match finished" again.
 *
 * Stand-in only; creates and deletes its own data. The server must run with
 * PUSH_DRY_RUN=1 (checked: dry-run deliveries carry a "dry-run" ticket).
 *
 *   LOCALDB_PORT=54331 npm run localdb                        # terminal 1
 *   npm run build                                             # no `next dev` running
 *   (set -a; . ./.env.localdb; set +a; PUSH_DRY_RUN=1 PUBLIC_SITE_URL=http://localhost:3087 npx next start -p 3087)
 *   npm run e2e:match-day
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { getTournament } from "../../src/lib/data";
import { awardGame, initialScoreState, type ScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { stateFromFinalScore, type EnteredSet } from "../../src/lib/scoring/finalScore";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { matchScreenCode } from "../../src/lib/pass/venueCode";
import type { Match, MatchRules } from "../../src/lib/types";
import { callCardModel, type CallSnapshot } from "../../src/lib/matchday/callCard";
import { matchDayRules, type MatchDayRules } from "../../src/lib/matchday/rules";
import {
  appUser,
  assertStandIn,
  bearer,
  check,
  eventually,
  finish,
  fixtures,
  http,
  lastEvent,
  scoreEvent,
  section,
  sendEvents,
  sleep,
  staff,
} from "./lib/fixtures";

assertStandIn("match-day.ts");

const REF = staff("referee");
const ADMIN = staff("admin");
const MIN = 60_000;

interface EventRow {
  id: string;
  kind: string;
  status: string;
  match_id: string | null;
  dedupe_key: string;
  fire_at: string;
  payload: { title: string; body: string; targets: { kind: string; key: string }[]; self?: { playerIds: string[]; title: string; body: string } };
}

async function events(matchId: string, kind: string): Promise<EventRow[]> {
  const { data } = await db().from("notification_events").select("id, kind, status, match_id, dedupe_key, fire_at, payload").eq("match_id", matchId).eq("kind", kind).order("created_at");
  return (data ?? []) as EventRow[];
}

async function deliveries(eventId: string): Promise<Map<string, string | null>> {
  const { data } = await db().from("notification_deliveries").select("device_id, status, ticket_id").eq("event_id", eventId);
  return new Map(((data ?? []) as { device_id: string; status: string; ticket_id: string | null }[]).filter((d) => d.status === "sent").map((d) => [d.device_id, d.ticket_id]));
}

async function matchRow(id: string) {
  const { data } = await db().from("matches").select("*").eq("id", id).single();
  return data as Match & { match_soon_at: string | null };
}

async function callRow(id: string) {
  const { data } = await db().from("match_calls").select("*").eq("match_id", id).maybeSingle();
  return data as { status: string; called_at: string; extensions: number; a_present_at: string | null; b_present_at: string | null; answer: { action: string } | null; called_by_role: string | null } | null;
}

/** Moves a call back in time, as if it had been made `ms` earlier. */
async function shiftCall(id: string, ms: number) {
  const row = await callRow(id);
  await db().from("match_calls").update({ called_at: new Date(Date.parse(row!.called_at) - ms).toISOString() }).eq("match_id", id);
}

const call = (id: string, body: Record<string, unknown>, who = REF) => http("POST", `/api/matches/${id}/call`, who, body);
const view = async (id: string, who = REF) => http("GET", `/api/matches/${id}/call`, who);

async function main() {
  const tag = randomUUID().slice(0, 6);
  const f = fixtures(tag);
  const device = `e2e-md-ref-${tag}`;
  try {
    const T = await f.tournament({ name: "E2E Match Day" });
    const t = await getTournament(T);
    const rules: MatchRules = scoringConfigForMatch(t, { stage: "group" }, null, { doubles: true });
    const names = Array.from({ length: 14 }, (_, i) => `T${i + 1}`);
    const { teams } = await f.teams(T, names);
    const team = (n: number) => teams[n - 1];
    const [C1, C2, C3, C4, C5, C6] = await f.courts(T, 6);
    const at = (min: number) => new Date(Date.now() + min * MIN).toISOString();

    const M1 = await f.match(T, { team_a_id: team(1).id, team_b_id: team(2).id, court_id: C1, match_order: 1, scheduled_time: at(-10) });
    const N1 = await f.match(T, { team_a_id: team(3).id, team_b_id: team(4).id, court_id: C1, match_order: 2, scheduled_time: at(20) });
    const N2 = await f.match(T, { team_a_id: team(4).id, team_b_id: team(5).id, court_id: C2, match_order: 1, scheduled_time: at(30) });
    const N3 = await f.match(T, { team_a_id: team(1).id, team_b_id: team(2).id, court_id: C3, match_order: 1, scheduled_time: at(40) });
    const X4 = await f.match(T, { team_a_id: team(12).id, team_b_id: team(13).id, court_id: C4, match_order: 1, scheduled_time: at(-10) });
    const N4 = await f.match(T, { team_a_id: team(14).id, team_b_id: null, court_id: C4, match_order: 2, scheduled_time: at(20) });
    const X5 = await f.match(T, { team_a_id: team(7).id, team_b_id: team(8).id, court_id: C5, match_order: 1, scheduled_time: at(-10) });
    const N5 = await f.match(T, { team_a_id: team(9).id, team_b_id: team(10).id, court_id: C5, match_order: 2, scheduled_time: at(20) });
    const X6 = await f.match(T, { team_a_id: team(10).id, team_b_id: team(11).id, court_id: C6, match_order: 1, scheduled_time: at(-10) });
    const R1 = await f.match(T, { team_a_id: team(1).id, team_b_id: team(2).id, court_id: null, match_order: 9 });

    // Phones. N1's players: T3 (p3a on d3a; p3b on d3b with court alerts off) and T4
    // (p4a: the "here" player, a real signed-in account; p4b on d4b). N2's T5 player
    // p5a: the QR player. A fan's phone stars N1. T9/T10 players for the busy check.
    const u3a = randomUUID();
    const u3b = randomUUID();
    const u4b = randomUUID();
    const u9 = randomUUID();
    const u10 = randomUUID();
    const here = await appUser(`e2e.md.here.${tag}@example.com`);
    const qr = await appUser(`e2e.md.qr.${tag}@example.com`);
    await f.link(u3a, team(3).players[0]);
    await f.link(u3b, team(3).players[1]);
    await f.link(here.userId, team(4).players[0]);
    await f.link(u4b, team(4).players[1]);
    await f.link(qr.userId, team(5).players[0]);
    await f.link(u9, team(9).players[0]);
    await f.link(u10, team(10).players[0]);
    const d3a = await f.device("d3a", { userId: u3a });
    const d3b = await f.device("d3b", { userId: u3b, prefs: { court: false } });
    const d4a = await f.device("d4a", { userId: here.userId });
    const d4b = await f.device("d4b", { userId: u4b });
    const d5a = await f.device("d5a", { userId: qr.userId });
    const d9 = await f.device("d9", { userId: u9 });
    const d10 = await f.device("d10", { userId: u10 });
    const fan = await f.device("fan");
    await f.follow(fan.installationId, "match", N1.id, T);

    /** One batch: the games named, each as a POINT_AWARDED carrying the state after the game. */
    async function play(m: Match, games: TeamKey[], opts: { start?: boolean } = {}) {
      const { n, state } = await lastEvent(m.id);
      let s = (state as ScoreState | null) ?? initialScoreState("A");
      let k = n;
      const evs: unknown[] = [];
      if (opts.start) evs.push(scoreEvent(++k, "MATCH_STARTED", null, s, { payload: { first_server: "A" } }));
      for (const g of games) {
        const next = awardGame(s, g, rules);
        evs.push(scoreEvent(++k, "POINT_AWARDED", s, next, { team_id: g === "A" ? m.team_a_id : m.team_b_id }));
        s = next;
      }
      return sendEvents(m.id, REF, evs, `${device}-${m.id.slice(0, 6)}`);
    }
    const fourAll: TeamKey[] = ["A", "B", "A", "B", "A", "B", "A", "B"];

    section("1. match soon: once, to the next match's own players");
    {
      const r = await play(M1, fourAll, { start: true });
      check(r.status === 200, "M1 started and played to 4-4", r.text);
      await sleep(800);
      check((await events(N1.id, "match_soon")).length === 0, "4-4 is not one game from the end: nothing sent");
      const r2 = await play(M1, ["A"]);
      check(r2.status === 200, "M1 5-4", r2.text);
      const soon = await eventually(async () => (await events(N1.id, "match_soon"))[0]);
      check(Boolean(soon), "5-4: a match_soon alert is stored for the next match on Court 1");
      check(soon?.dedupe_key === `match:${M1.id}:soon`, "…keyed on the match nearly over (once per match)", soon?.dedupe_key);
      check(
        JSON.stringify(soon?.payload.self?.playerIds?.slice().sort()) === JSON.stringify([...team(3).players, ...team(4).players].sort()),
        "…addressed to N1's four players",
        soon?.payload.self,
      );
      // Followers of each player get it (fans' wording); people who only starred the match do not (off by default).
      const targets = soon?.payload.targets ?? [];
      check(
        targets.every((x: { kind: string }) => x.kind === "player") &&
          JSON.stringify(targets.map((x: { key: string }) => x.key).sort()) === JSON.stringify([...team(3).players, ...team(4).players].sort()),
        "…to the followers of those four players, and to no one who only starred the match (off by default)",
        targets,
      );
      check(!/phone|email|access_code|\+20/.test(JSON.stringify(soon?.payload ?? {})), "…carrying no private player field");
      const sent = await eventually(async () => {
        const d = await deliveries(soon!.id);
        return d.size >= 3 ? d : null;
      });
      check(Boolean(sent), "the drain sent it", sent ? [...sent.values()] : null);
      check(sent?.get(d3a.id) === "dry-run:self" && sent?.get(d4a.id) === "dry-run:self" && sent?.get(d4b.id) === "dry-run:self", "linked players' phones got their own wording (dry run)", sent ? Object.fromEntries(sent) : null);
      if (sent && [...sent.values()].some((v) => !v?.startsWith("dry-run"))) console.log("   ⚠ the server is not in PUSH_DRY_RUN: start it with PUSH_DRY_RUN=1");
      check(!sent?.has(d3b.id), "a phone with court alerts off got nothing");
      check(!sent?.has(fan.id), "the fan who starred N1 got nothing");
      check(Boolean((await matchRow(M1.id)).match_soon_at), "M1.match_soon_at is set");

      await play(M1, ["B"]);
      await play(M1, ["A"]);
      await sleep(1500);
      check((await events(N1.id, "match_soon")).length === 1, "5-5 then 6-5 crosses again: nothing more is sent");
    }

    section("2. not for a side to be decided, not for players busy elsewhere");
    {
      const r = await play(X4, fourAll, { start: true });
      const r2 = await play(X4, ["A"]); // 5-4: crosses
      check(r.status === 200 && r2.status === 200, "X4 comes one game from the end", r2.text);
      await sleep(1500);
      check((await events(N4.id, "match_soon")).length === 0, "the next match on Court 4 has a side to be decided: nothing sent");
      check(!(await matchRow(X4.id)).match_soon_at, "…and X4 is not marked, so it could still go out later");

      const s6 = await play(X6, [], { start: true });
      check(s6.status === 200, "X6 (T10 v T11) is live on Court 6", s6.text);
      await play(X5, fourAll, { start: true });
      await play(X5, ["A"]);
      const soon = await eventually(async () => (await events(N5.id, "match_soon"))[0]);
      check(
        JSON.stringify(soon?.payload.self?.playerIds?.slice().sort()) === JSON.stringify([...team(9).players].sort()),
        "N5's alert skips T10's players, who are on Court 6",
        soon?.payload.self,
      );
      const sent = soon ? await eventually(async () => ((await deliveries(soon.id)).size ? await deliveries(soon.id) : null)) : null;
      check(Boolean(sent?.has(d9.id)) && !sent?.has(d10.id), "T9's player is told, T10's busy player is not", sent ? Object.fromEntries(sent) : null);
    }

    section("3. calling to court");
    {
      const busy = await call(N1.id, { action: "call" });
      check(busy.status === 409 && busy.json?.code === "court_busy", "Court 1 is busy (M1 live): 409 court_busy", busy.text);
      const fin = await play(M1, ["A"]); // 7-5
      check(fin.status === 200 && (await matchRow(M1.id)).status === "completed", "M1 finishes 7-5", fin.text);
      const c = await call(N1.id, { action: "call" });
      check(c.status === 201 && (c.json?.created as boolean) === true, "N1 is called (201)", c.text);
      check((await matchRow(N1.id)).status === "ready", "N1 is ready");
      const again = await call(N1.id, { action: "call" });
      check(again.status === 200 && again.json?.created === false, "calling again gives the same call (200)", again.text);
      const called = await events(N1.id, "called_to_court");
      check(called.length === 1, "one called_to_court alert", called.length);
      const sent = called[0] ? await eventually(async () => ((await deliveries(called[0].id)).size >= 3 ? await deliveries(called[0].id) : null)) : null;
      check(Boolean(sent?.get(d3a.id) === "dry-run:self" && sent?.get(d4a.id) && sent?.get(d4b.id)) && !sent?.has(d3b.id) && !sent?.has(fan.id), "the players were alerted in their own wording, not the court-off phone or the fan", sent ? Object.fromEntries(sent) : null);
      const reminder = (await events(N1.id, "call_reminder")).filter((e) => e.status === "pending");
      const calledAt = Date.parse((await callRow(N1.id))!.called_at);
      check(reminder.length === 1 && Math.abs(Date.parse(reminder[0].fire_at) - (calledAt + 3 * MIN)) < 2000, "the reminder waits for the deadline − 2 min", reminder.map((e) => e.fire_at));

      const v = await view(N1.id);
      const cv = v.json?.call as { view: { phase: string; actions: string[] } } | undefined;
      check(v.status === 200 && cv?.view.phase === "called" && cv.view.actions.includes("mark_present_a"), "GET: phase called, mark present offered", v.text);
      check(!/device_id|phone|email|access_code/.test(v.text), "GET carries no device id or private player field");

      const p = await call(N1.id, { action: "present", side: "A" });
      check(p.status === 200 && (await callRow(N1.id))?.a_present_at !== null, "the referee marks T3 present", p.text);
      const trimmed = (await events(N1.id, "call_reminder")).find((e) => e.status === "pending");
      check(JSON.stringify(trimmed?.payload.self?.playerIds?.slice().sort()) === JSON.stringify([...team(4).players].sort()), "the reminder now goes only to T4, still missing", trimmed?.payload.self);

      // The scheduled drain (the cron route) sends it when due.
      await db().from("notification_events").update({ fire_at: new Date(Date.now() - 1000).toISOString() }).eq("id", trimmed!.id);
      const cron = await http("POST", "/api/internal/notifications/drain", { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` }, {});
      check(cron.status === 200, "the cron drain runs", cron.text);
      const rs = await deliveries(trimmed!.id);
      check(rs.has(d4a.id) && rs.has(d4b.id) && !rs.has(d3a.id), "the reminder reached T4's players only", Object.fromEntries(rs));
    }

    section("4. no-show: wait, extend, walkover");
    {
      const early = await call(N1.id, { action: "extend" });
      check(early.status === 409 && early.json?.code === "not_due", "no extension before the deadline", early.text);
      await shiftCall(N1.id, 6 * MIN);
      const v = await view(N1.id);
      const cv = (v.json?.call as { view: { phase: string; prompt: { kind: string; absent: string[] } | null; actions: string[] } }).view;
      check(cv.phase === "no_show" && cv.prompt?.kind === "one_absent" && cv.prompt.absent.join() === "B", "past the deadline: the no-show prompt, T4 absent", cv);
      check(cv.actions.includes("extend") && cv.actions.includes("walkover_to_a") && !cv.actions.includes("walkover_to_b"), "…offering +5 and the walkover to T3", cv.actions);
      const wait = await call(N1.id, { action: "answer", answer: "wait" });
      check(wait.status === 200 && (await callRow(N1.id))?.answer?.action === "wait", "keep waiting is recorded", wait.text);
      const e1 = await call(N1.id, { action: "extend" });
      check(e1.status === 200 && (await callRow(N1.id))?.extensions === 1, "+5 min (1 of 2)", e1.text);
      const pending = (await events(N1.id, "call_reminder")).filter((e) => e.status === "pending");
      check(pending.length === 1 && pending[0].dedupe_key !== `x`, "a new reminder for the new deadline", pending.map((e) => e.dedupe_key));
      const tooSoon = await call(N1.id, { action: "extend" });
      check(tooSoon.status === 409 && tooSoon.json?.code === "not_due", "the next extension waits for the new deadline", tooSoon.text);
      await shiftCall(N1.id, 5 * MIN);
      const e2 = await call(N1.id, { action: "extend" });
      check(e2.status === 200 && (await callRow(N1.id))?.extensions === 2, "+5 min (2 of 2)", e2.text);
      await shiftCall(N1.id, 5 * MIN);
      const e3 = await call(N1.id, { action: "extend" });
      check(e3.status === 409 && e3.json?.code === "max_extensions", "a third extension is refused", e3.text);
      const wrong = await call(N1.id, { action: "answer", answer: "walkover_to_b" });
      check(wrong.status === 409 && wrong.json?.code === "not_allowed", "a walkover to the absent side is refused", wrong.text);
      const wo = await call(N1.id, { action: "answer", answer: "walkover_to_a", deviceId: `${device}-n1` });
      check(wo.status === 200, "walkover to T3", wo.text);
      const m = await matchRow(N1.id);
      check(m.status === "walkover" && m.winner_team_id === team(3).id, "N1 is a walkover won by T3", `${m.status}`);
      const cr = await callRow(N1.id);
      check(cr?.status === "walkover" && cr.answer?.action === "walkover_to_a", "the call is closed as a walkover with the answer", cr);
      const { data: ev } = await db().from("score_events").select("event_type").eq("match_id", N1.id);
      check(((ev ?? []) as { event_type: string }[]).some((e) => e.event_type === "WALKOVER"), "recorded through the scoring path (a WALKOVER event)");
      check((await events(N1.id, "call_reminder")).every((e) => e.status !== "pending"), "no reminder left pending");
    }

    section("5. auto call on referee open, \"I'm at court\", QR check-in");
    {
      const early = await http("POST", `/api/mobile/v1/me/matches/${N2.id}/here`, bearer(here.token));
      check(early.status === 409 && early.json?.code === "no_call", "\"I'm at court\" before the call: 409 no_call", early.text);
      const before = await http("GET", `/api/mobile/v1/me/matches/${N2.id}/here`, bearer(here.token));
      check(before.status === 200 && before.json?.side === "A" && before.json?.call === null && before.json?.imAtCourt === true, "GET here before the call: my side, \"I'm at court\" on, no call yet", before.text);
      const boot = await http("GET", `/api/mobile/v1/referee/matches/${N2.id}/bootstrap`, REF);
      check(boot.status === 200, "the referee phone opens N2", boot.text.slice(0, 200));
      const cr = await callRow(N2.id);
      check(cr?.status === "called" && cr.called_by_role === "referee:auto" && (await matchRow(N2.id)).status === "ready", "opening it called it to court (auto on referee open)", cr);
      check((boot.json?.call as { status?: string } | null)?.status === "called", "the bootstrap carries the call");
      check(boot.json?.legs === 1 && (boot.json?.matchDay as { courtCall?: { on?: boolean } } | null)?.courtCall?.on === true, "…with the match-day rules the phone counts down with, and the chess legs", { legs: boot.json?.legs });
      // The phone's call card from the bootstrap alone (callCardModel, shared with the web console).
      const card = callCardModel({
        call: boot.json?.call as CallSnapshot,
        rules: boot.json?.matchDay as MatchDayRules,
        nowMs: Date.now(),
        matchStatus: "ready",
        hasCourt: true,
        names: { A: "T4", B: "T5" },
      });
      check(card.show && card.phase === "called" && /^[0-5]:[0-5]\d$/.test(card.countdown ?? "") && card.sides.every((s) => s.canMark), "the app's call card: called, counting down, both sides can be marked", card);
      const mid = await http("GET", `/api/mobile/v1/me/matches/${N2.id}/here`, bearer(here.token));
      const midCall = mid.json?.call as { status?: string; deadlineAt?: string; presentA?: boolean } | null;
      check(mid.status === 200 && midCall?.status === "called" && Boolean(midCall.deadlineAt) && midCall.presentA === false, "GET here once called: the deadline, not yet present", mid.text);
      check(!/actions|prompt|answer|view|extensions/.test(mid.text), "…and never the referee's prompt, actions or answer", mid.text);
      const midOther = await http("GET", `/api/mobile/v1/me/matches/${N3.id}/here`, bearer(here.token));
      check(midOther.status === 404, "GET here on someone else's match: 404", midOther.text);
      const midGuest = await http("GET", `/api/mobile/v1/me/matches/${N2.id}/here`, {});
      check(midGuest.status === 401, "GET here without signing in: 401", midGuest.text);

      const notMine = await http("POST", `/api/mobile/v1/me/matches/${N3.id}/here`, bearer(here.token));
      check(notMine.status === 404, "\"I'm at court\" on someone else's match: 404", notMine.text);
      const guest = await http("POST", `/api/mobile/v1/me/matches/${N2.id}/here`, {});
      check(guest.status === 401, "without signing in: 401", guest.text);
      const h = await http("POST", `/api/mobile/v1/me/matches/${N2.id}/here`, bearer(here.token));
      check(h.status === 200 && h.json?.side === "A" && (await callRow(N2.id))?.a_present_at !== null, "T4's player marks themselves present (side A)", h.text);
      check(!/actions|prompt|answer/.test(h.text), "the player's answer carries no referee prompt", h.text);
      const seen = await http("GET", `/api/mobile/v1/me/matches/${N2.id}/here`, bearer(here.token));
      check((seen.json?.call as { presentA?: boolean } | null)?.presentA === true, "GET here shows the player as present", seen.text);

      const scan = await http("POST", `/api/mobile/v1/matches/${N2.id}/checkin`, bearer(qr.token), { c: matchScreenCode(N2.id) });
      const after = await callRow(N2.id);
      check(after?.b_present_at !== null, "T5's player scanning the court code is marked present (side B)", `${scan.status} ${scan.text.slice(0, 160)}`);
      const v = await view(N2.id);
      check((v.json?.call as { view: { phase: string } }).view.phase === "all_present", "both present: ready to start", v.text);
      check((await events(N2.id, "call_reminder")).every((e) => e.status !== "pending"), "the reminder is withdrawn");
      void d5a;

      const start = await sendEvents(N2.id, REF, [scoreEvent(1, "MATCH_STARTED", null, initialScoreState("A"), { payload: { first_server: "A" } })], `${device}-n2`);
      check(start.status === 200 && (await callRow(N2.id))?.status === "started", "MATCH_STARTED closes the call", start.text);
    }

    section("6. both absent: a prompt only");
    {
      const c = await call(N3.id, { action: "call" });
      check(c.status === 201, "N3 is called", c.text);
      await shiftCall(N3.id, 6 * MIN);
      const v = await view(N3.id);
      const cv = (v.json?.call as { view: { phase: string; prompt: { kind: string } | null; actions: string[] } }).view;
      check(cv.prompt?.kind === "both_absent" && !cv.actions.some((a) => a.startsWith("walkover") || a === "both_no_show"), "both absent: no walkover offered", cv);
      const sheet = callCardModel({ call: v.json?.call as CallSnapshot, rules: matchDayRules(t!.match_day_rules, t!), nowMs: Date.now(), matchStatus: "ready", hasCourt: true, names: { A: "T1", B: "T2" } });
      check(sheet.phase === "no_show" && (sheet.noShow ?? []).every((o) => !o.choice.startsWith("walkover")), "the consoles' no-show sheet offers no walkover either", sheet.noShow?.map((o) => o.choice));
      const wo = await call(N3.id, { action: "answer", answer: "walkover_to_a" });
      check(wo.status === 409 && wo.json?.code === "not_allowed", "a walkover is refused", wo.text);
      const wait = await call(N3.id, { action: "answer", answer: "wait" });
      check(wait.status === 200, "wait is accepted", wait.text);

      section("7. another organisation's referee");
      const other = await f.otherOrgReferee();
      const g = await view(N3.id, other.who);
      const p = await call(N3.id, { action: "extend" }, other.who);
      check(g.status === 404 && p.status === 404 && !g.text.includes(team(1).id), "GET and POST are 404 for another organisation's referee", `${g.status} ${p.status}`);
      const x = await http("POST", `/api/matches/${N3.id}/call`, REF, { action: "call", sneaky: true });
      check(x.status === 400, "unknown fields are refused", x.text);

      const cancel = await call(N3.id, { action: "cancel" });
      check(cancel.status === 200 && (await callRow(N3.id))?.status === "cancelled" && (await matchRow(N3.id)).status === "scheduled", "the call is withdrawn: N3 back to scheduled", cancel.text);
      // L1: a call / cancel loop neither spams the players nor runs forever.
      const recall = await call(N3.id, { action: "call" });
      check(recall.status === 201 && (await events(N3.id, "called_to_court")).length <= 1, "called again within 10 minutes: no second \"called to court\" alert", { status: recall.status, alerts: (await events(N3.id, "called_to_court")).length });
      const statuses: number[] = [];
      for (let i = 0; i < 14 && !statuses.includes(429); i++) statuses.push((await call(N3.id, { action: i % 2 === 0 ? "cancel" : "call" })).status);
      // So far: call, cancel, call (3 of 12 per 10 minutes) — the 10th more is the 13th.
      check(statuses.includes(429) && statuses.length === 10 && statuses.slice(0, -1).every((x) => x === 200 || x === 201), "call / extend / cancel: at most 12 per match per 10 minutes, counted atomically (then 429)", statuses);
      check((await events(N3.id, "called_to_court")).length <= 1, "…and the players heard \"called to court\" once, whatever the loop", (await events(N3.id, "called_to_court")).length);
      await db().from("request_counters").delete().eq("bucket_key", `match-call:${N3.id}`);
    }

    section("8. Phase 2 leftovers: Undo after a result; no second \"finished\"");
    {
      const sets: EnteredSet[] = [{ a: 6, b: 3 }];
      const built = stateFromFinalScore(rules, sets);
      if (!built.ok) throw new Error("fixture");
      const r = await sendEvents(R1.id, REF, [scoreEvent(1, "RESULT_ENTERED", null, built.state, { team_id: team(1).id, payload: { sets } })], `${device}-r1`);
      check(r.status === 200 && (await matchRow(R1.id)).status === "completed", "a result is entered", r.text);
      check((await events(R1.id, "match_finished")).length === 1, "one match_finished alert");
      const undo = await sendEvents(R1.id, REF, [scoreEvent(2, "UNDO", built.state, initialScoreState("A"))], `${device}-r1`);
      check(undo.status === 409 && undo.json?.conflict === "result_entered", "an Undo after the result is refused (409 result_entered)", undo.text);
      const { count } = await db().from("score_events").select("id", { count: "exact", head: true }).eq("match_id", R1.id);
      check(count === 1, "…and nothing was written", count);
      const fix: EnteredSet[] = [{ a: 2, b: 6 }];
      const fixed = stateFromFinalScore(rules, fix);
      if (!fixed.ok) throw new Error("fixture");
      const byRef = await sendEvents(R1.id, REF, [scoreEvent(2, "RESULT_ENTERED", built.state, fixed.state, { team_id: team(2).id, payload: { sets: fix } })], `${device}-r1`);
      check(byRef.status === 409 && byRef.json?.conflict === "organiser_only" && (await matchRow(R1.id)).winner_team_id === team(1).id, "a referee code cannot correct the finished result (409 organiser_only)", byRef.text);
      const c = await sendEvents(R1.id, ADMIN, [scoreEvent(2, "RESULT_ENTERED", built.state, fixed.state, { team_id: team(2).id, payload: { sets: fix } })], `${device}-r1`);
      const m = await matchRow(R1.id);
      check(c.status === 200 && m.winner_team_id === team(2).id && m.result_source === "correction", "the organiser's corrected result is recorded", c.text);
      await sleep(500);
      check((await events(R1.id, "match_finished")).length === 1, "the correction sends no second \"match finished\"");
    }
  } finally {
    check(await f.cleanup(), "cleaned up");
  }
  finish("match-day");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
