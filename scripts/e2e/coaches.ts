/**
 * National team coach access (migration 0037), end to end on the stand-in: two tie events
 * of one event group (the Junior Finals' shape: boys and girls, Egypt in both), and
 *   - confirming the draw (generating the group ties) makes a code for every team, once; the
 *     admin's button makes none after it (a manager cannot), cards and share PNGs are branded,
 *     the Team coaches page lists them, the printable cards carry a QR of /c#<code>;
 *   - the coach of Egypt boys signs in on two phones (and the web) with the same code and
 *     sees only Egypt boys: its group table, its ties with court and time, its own line-up
 *     once entered, the opponents' players once the line-ups are confirmed (not before), live score and match
 *     log of its own rubbers without referee names, the players' schedule;
 *   - another team's tie / rubber / line-up / log answers 404 exactly like a missing one;
 *     every staff route (referee lists, scoring, line-ups, assistance, match log, admin)
 *     refuses the coach token; coach routes are read only;
 *   - alerts (PUSH_DRY_RUN) to both coach phones: line-up entered (own players only),
 *     started, called to court, finished, tie soon (scheduled);
 *   - revoking the code fails the next request on every device; a new code replaces the old;
 *   - failed sign-ins are braked (atomic, per address), right ones are not counted;
 *   - the QR page /c without the app: download links, never a sign-in by itself; AASA has /c;
 *   - coach line-up entry (coachLineupEntry below): off by default (409 feature_off, nothing shown), then switched
 *     on by an admin: own line-up, warnings accepted + audited + masters alerted, opponent never sees it, officials
 *     confirm (locks), locked / deadline / brakes refuse, off again.
 *
 *   npm run localdb                                                     # another terminal
 *   npm run build && PUSH_DRY_RUN=1 npx next start -p 3077              # env from .env.localdb
 *   npm run e2e:coaches
 *
 * Creates and deletes its own data.
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { finalizeMatch, upsertSnapshotFromState } from "../../src/lib/ops";
import { getTournament } from "../../src/lib/data";
import { generateGroupTies, getTies, lockLineups, scheduleTie, setLineup, type DrawReport } from "../../src/lib/tennis/tieOps";
import { formatEventCode, hashEventCode, openEventCode } from "../../src/lib/orgs/codes";
import { coachLink, parseCoachLink } from "../../src/lib/coaches/rules";
import { mintInstallToken } from "../../src/lib/mobile/identity";
import { eventDay } from "../../src/lib/matchday/eventDay";
import { zonedToIso } from "../../src/lib/tennis/ties";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Match, type Tie } from "../../src/lib/types";
import { clearRequestCounters, BASE_URL, assertStandIn, bearer, check, eventually, finish, fixtures, http, scoreEvent, section, sendEvents, staff, type Who } from "./lib/fixtures";
import { actionOk, callAction, form } from "./lib/actions";

assertStandIn("coaches");

const tag = randomUUID().slice(0, 6);
const f = fixtures(tag);
const made = { group: null as string | null, referees: [] as string[] };
const TZ = "Africa/Cairo";
const today = eventDay(TZ);
const at = (hhmm: string) => zonedToIso(`${today}T${hhmm}`, TZ)!;
const ip = (n: number): Who => ({ "X-Forwarded-For": `203.0.113.${n}` });
const SESSION = "/api/mobile/v1/coach/session";
const ACTIONS = "src/app/admin/org/coaches/actions.ts";
const coachCookie = (token: string): Who => ({ Cookie: `mb_coach=${token}` });

async function finishDirect(m: Match, winner: TeamKey) {
  const t = (await getTournament(m.tournament_id))!;
  const cfg = scoringConfigForMatch(t, m, null, { doubles: m.rubber_type === "D" });
  let s = initialScoreState("A");
  let n = 0;
  while (!s.matchOver) {
    s = awardPoint(s, winner, cfg);
    n++;
  }
  await upsertSnapshotFromState(m, s, n);
  await finalizeMatch(m, { status: "completed", winnerTeamId: winner === "A" ? m.team_a_id! : m.team_b_id!, actorRole: "e2e" });
}

const webAfter0 = (r: { status: number; text: string }, name: string) => r.status === 200 && r.text.includes(name);

const shownState = (text: string, key: string) => new RegExp(`"${key}":"([^"]+)"`).exec(text)?.[1] ?? null;
type Squad = { id: string; players: string[] };

/**
 * Coach line-up entry (behind the event's switch, off by default): off → refused and
 * invisible everywhere; on → Egypt's coach submits its own line-up (a Reg 43 warning needs
 * accepting, is audited with "Coach of Egypt" and alerts the master referee; the court
 * referee and the master are told of the submission), the opponent's coach never sees it,
 * the officials see it prefilled ("Submitted by the coach at HH:MM") and confirming locks
 * it, after which the coach is refused; another team's tie 404; a deadline closes it; brakes.
 */
async function coachLineupEntry(x: {
  BOYS: string;
  GIRLS: string;
  T2: Tie;
  T3: Tie;
  bc2: string;
  EGYB: Squad;
  bt: Squad[];
  C1: Who;
  C2: Who;
  W: Who;
  codeOf: (teamId: string) => { id: string; code: string };
  ADMIN: Who;
  MB: string;
}) {
  const { BOYS, GIRLS, T2, T3, EGYB, C1, W, ADMIN } = x;
  const LU = (tie: string) => `/api/mobile/v1/coach/ties/${tie}/lineup`;
  const egySide: "A" | "B" = T2.team_a_id === EGYB.id ? "A" : "B";
  const oppSide: "A" | "B" = egySide === "A" ? "B" : "A";
  const opp = x.bt.find((t) => t.id === (egySide === "A" ? T2.team_b_id : T2.team_a_id))!;
  await scheduleTie(BOYS, T2.id, x.bc2, new Date(Date.now() + 3 * 3600_000).toISOString(), "e2e");
  await scheduleTie(BOYS, T3.id, x.bc2, new Date(Date.now() + 5 * 3600_000).toISOString(), "e2e");
  const r2 = ((await db().from("matches").select("id, rubber_type").eq("tie_id", T2.id).order("rubber_no")).data ?? []) as { id: string; rubber_type: string }[];
  const submissions = async () => ((await db().from("audit_logs").select("id, actor_name, actor_role, new_value").eq("entity_id", T2.id).eq("action", "COACH_LINEUP_SUBMITTED")).data ?? []) as { id: string; actor_name: string | null; actor_role: string; new_value: { side: string; lineup: { S1: string } } }[];
  const egyRubberIds = async () => (((await db().from("matches").select(egySide === "A" ? "team_a_player_ids" : "team_b_player_ids").eq("tie_id", T2.id)).data ?? []) as unknown as Record<string, string[] | null>[]).flatMap((r) => Object.values(r)[0] ?? []);
  const good = { S1: EGYB.players[0], S2: EGYB.players[1], D: [null, null] };
  const swapped = { S1: EGYB.players[1], S2: EGYB.players[0], D: [EGYB.players[2], EGYB.players[3]] };

  section("Coach line-up entry is off by default: read only, nothing shown anywhere");
  const fc0 = (await db().from("tournaments").select("format_config").eq("id", BOYS).single()).data as { format_config: { ties: { coachLineups?: unknown } } };
  check(fc0.format_config.ties.coachLineups === undefined, "a nations event starts with no coach line-up switch (off)", fc0.format_config.ties);
  const tieOff = await http("GET", `/api/mobile/v1/coach/ties/${T2.id}`, C1);
  const luOff = await http("GET", LU(T2.id), C1);
  const postOff = await http("POST", LU(T2.id), C1, { lineup: good });
  check(tieOff.status === 200 && tieOff.json?.lineupEntry === undefined && luOff.status === 200 && luOff.json?.entry === undefined, "off: the tie carries no lineupEntry, the line-up no entry form", [tieOff.json?.lineupEntry, luOff.json?.entry]);
  check(postOff.status === 409 && postOff.json?.code === "feature_off" && (await submissions()).length === 0, "off: a coach's submission is 409 feature_off and nothing is recorded", [postOff.status, postOff.json?.code]);
  const webOff = await http("GET", `/coach/ties/${T2.id}`, W);
  const teamOff = await http("GET", "/coach/team", W);
  check(webOff.status === 200 && !webOff.text.includes("coach-lineup-form") && !teamOff.text.includes("coach-enter-lineup"), "off: no line-up form or Enter line-up on the web", [webOff.status]);
  const pickOff = await http("GET", `/api/mobile/v1/referee/matches/${r2[0].id}/lineup`, ADMIN);
  check(pickOff.status === 200 && pickOff.json?.coach === undefined, "off: the officials' picker says nothing about coach submissions", Object.keys(pickOff.json ?? {}));
  const swMgr = await callAction(ACTIONS, "saveCoachLineupSettingsAction", [form({ tournament_id: BOYS, event: BOYS, on: "on" })], staff("manager"));
  const swRef = await callAction(ACTIONS, "saveCoachLineupSettingsAction", [form({ tournament_id: BOYS, event: BOYS, on: "on" })], staff("referee"));
  const still = (await db().from("tournaments").select("format_config").eq("id", BOYS).single()).data as { format_config: { ties: { coachLineups?: { on?: boolean } } } };
  check(!actionOk(swMgr) && !actionOk(swRef) && !still.format_config.ties.coachLineups?.on, "a manager and a referee cannot switch it on (admins only)", [swMgr.status, swRef.status]);
  const switchPage = await http("GET", `/admin/org/coaches?event=${BOYS}`, ADMIN);
  check((switchPage.text.match(/data-testid="coach-lineups-switch"/g) ?? []).length === 2 && !switchPage.text.includes('data-on="1"'), "the Team coaches page shows the switch per event, both off", null);

  section("An admin switches it on; officials sign in on Court 2 and as master referee");
  const sw = await callAction(ACTIONS, "saveCoachLineupSettingsAction", [form({ tournament_id: BOYS, event: BOYS, on: "on", deadline_minutes: "" })], ADMIN);
  const fc1 = (await db().from("tournaments").select("format_config").eq("id", BOYS).single()).data as { format_config: { ties: { coachLineups?: { on?: boolean; deadlineMinutes?: number | null }; rubbers?: string[] } } };
  const girls = (await db().from("tournaments").select("format_config").eq("id", GIRLS).single()).data as { format_config: { ties: { coachLineups?: { on?: boolean } } } };
  check(actionOk(sw) && fc1.format_config.ties.coachLineups?.on === true && fc1.format_config.ties.coachLineups.deadlineMinutes === null && fc1.format_config.ties.rubbers?.length === 3 && !girls.format_config.ties.coachLineups?.on, "on for the boys' event only (the rest of its tie settings kept; the girls' stays off)", fc1.format_config.ties);
  const addRef = async (name: string, role: "referee" | "master_referee") => {
    const r = await callAction("src/app/admin/org/referees/actions.ts", "createRefereeAction", [null, form({ name: `${name} ${tag}`, role, phone: "+20 100 000 0000", event_group_id: made.group! })], ADMIN);
    const pin = shownState(r.text, "pin");
    const { data } = await db().from("referees").select("id").eq("organization_id", x.MB).eq("name", `${name} ${tag}`).single();
    made.referees.push((data as { id: string }).id);
    return { id: (data as { id: string }).id, pin: pin! };
  };
  const NADA = await addRef("Nada", "referee");
  const HANY = await addRef("Hany", "master_referee");
  const cc = await callAction("src/app/admin/org/codes/courts/actions.ts", "createCourtCodesAction", [form({ tournament_id: BOYS, expires: "event_end" })], ADMIN);
  const { data: codeRows } = await db().from("organization_codes").select("court_name, code_sealed").eq("event_group_id", made.group);
  const court2 = formatEventCode(openEventCode(((codeRows ?? []) as { court_name: string; code_sealed: string }[]).find((c) => c.court_name === "Court 2")!.code_sealed)!);
  const refPhone = await f.device("ref2");
  const refInstall = mintInstallToken(refPhone.installationId);
  const rs = await http("POST", "/api/mobile/v1/staff/session", { ...ip(61), "X-Install-Token": refInstall }, { code: court2, pin: NADA.pin, refereeId: NADA.id });
  const REF: Who = { ...bearer(String(rs.json?.token)), "X-Install-Token": refInstall };
  const mc = await callAction("src/app/admin/org/referees/actions.ts", "createMasterCodeAction", [null, form({ referee_id: HANY.id, event_group_id: made.group!, expires_days: "7" })], ADMIN);
  const mPhone = await f.device("master");
  const mInstall = mintInstallToken(mPhone.installationId);
  const ms = await http("POST", "/api/mobile/v1/staff/session", { ...ip(62), "X-Install-Token": mInstall }, { code: shownState(mc.text, "code"), pin: HANY.pin, refereeId: HANY.id });
  const MASTER: Who = { ...bearer(String(ms.json?.token)), "X-Install-Token": mInstall };
  await http("GET", "/api/mobile/v1/referee/assistance", MASTER); // records the master's phone for alerts
  check(actionOk(cc) && rs.status === 200 && ms.status === 200, "Nada on Court 2 and Hany the master referee: signed in with their PINs and phones", [cc.status, rs.status, ms.status]);

  section("On: Egypt's coach enters its own line-up");
  const tieOn = await http("GET", `/api/mobile/v1/coach/ties/${T2.id}`, C1);
  const luOn = await http("GET", LU(T2.id), C1);
  const entry = luOn.json?.entry as import("../../src/lib/mobile/contract").MCoachLineupEntry | undefined;
  check(tieOn.json?.lineupEntry !== undefined && (tieOn.json?.lineupEntry as { open: boolean }).open === true, "the tie says the coach may enter the line-up (the app's Enter line-up)", tieOn.json?.lineupEntry);
  check(Boolean(entry) && entry!.open && entry!.side === egySide && entry!.squad.map((p) => p.id).join() === EGYB.players.join() && entry!.submitted === null, "the form: Egypt's own squad in order of merit, nothing submitted yet", entry && { open: entry.open, side: entry.side });
  check(!opp.players.some((id) => luOn.text.includes(id)), "the form names none of the opponent's players", null);
  const webOn = await http("GET", `/coach/ties/${T2.id}`, W);
  const teamOn = await http("GET", "/coach/team", W);
  check(webOn.text.includes('data-testid="coach-lineup-form"') && webOn.text.includes('data-open="1"') && teamOn.text.includes("coach-enter-lineup"), "the web tie page has the line-up form; My team has Enter line-up", null);
  const same = await http("POST", LU(T2.id), C1, { lineup: { S1: EGYB.players[0], S2: EGYB.players[0], D: [] } });
  const oppPlayer = await http("POST", LU(T2.id), C1, { lineup: { S1: opp.players[0], S2: EGYB.players[1], D: [] } });
  const junk = await http("POST", LU(T2.id), C1, { lineup: "S1" });
  check(same.status === 400 && same.json?.code === "problems" && oppPlayer.status === 400 && junk.status === 400, "problems refuse: the same player twice, another team's player, a malformed body", [same.status, oppPlayer.status, junk.status]);
  const warn = await http("POST", LU(T2.id), C1, { lineup: swapped });
  const w = (warn.json?.warnings as { code: string; reg: string; key: string }[] | undefined) ?? [];
  check(warn.status === 409 && warn.json?.code === "warnings" && w.length === 1 && w[0].code === "order_of_merit" && w[0].reg === "43", "No. 2 at Singles 1: 409, a Reg 43 warning to accept (with its regulation)", warn.json);
  check((await submissions()).length === 0, "nothing recorded until the coach accepts it", null);
  const sub = await http("POST", LU(T2.id), C1, { lineup: swapped, accept: [w[0]?.key] });
  check(sub.status === 200 && sub.json?.changed === true && (sub.json?.entry as { submitted: { at: string } | null }).submitted !== null, "accepted: the line-up is submitted", [sub.status, sub.json?.error]);
  check(Number(sub.json?.exceptionAlerted) >= 1 && Number(sub.json?.officialsAlerted) >= 2, "the master referee's phone hears the exception; the chair umpire and the master hear the submission (dry run)", [sub.json?.exceptionAlerted, sub.json?.officialsAlerted]);
  const rows = await submissions();
  const { data: exc } = await db().from("audit_logs").select("actor_name, actor_role, new_value").eq("entity_id", T2.id).eq("action", "LINEUP_EXCEPTION_ACCEPTED");
  const e0 = ((exc ?? []) as { actor_name: string | null; actor_role: string; new_value: { actor: string; by: string; issues: { reg: string }[]; text: string } }[])[0];
  check(rows.length === 1 && rows[0].actor_role === "coach" && rows[0].actor_name === `Coach of Egypt ${tag}` && rows[0].new_value.side === egySide, "audited: COACH_LINEUP_SUBMITTED by “Coach of Egypt”", rows);
  check(Boolean(e0) && e0.actor_name === `Coach of Egypt ${tag}` && e0.new_value.actor === "coach" && e0.new_value.issues[0]?.reg === "43" && /Coach of Egypt .* accepted a line-up exception on Court 2/.test(e0.new_value.text), "the exception audited (actor = coach of Egypt, Reg 43), like an official's", e0);
  const notices = await http("GET", "/api/mobile/v1/referee/notices", MASTER);
  check(notices.status === 200 && notices.text.includes(`Coach of Egypt ${tag}`), "the master referee's banner shows the coach's exception", notices.status);
  check((await egyRubberIds()).length === 0, "a submission is never written to the rubbers (no public page or opponent sees it)", await egyRubberIds());
  const again = await http("POST", LU(T2.id), C1, { lineup: swapped, accept: [w[0]?.key] });
  check(again.status === 200 && again.json?.changed === false && (await submissions()).length === 1, "the same line-up again: nothing new recorded or alerted", again.json?.changed);
  const fromPhone2 = await http("GET", LU(T2.id), x.C2);
  check((fromPhone2.json?.entry as { submitted: { lineup: { S1: string } } | null }).submitted?.lineup.S1 === EGYB.players[1], "the assistant's phone (same code) sees the submission", null);

  section("The opponent's coach never sees Egypt's draft; another team's tie is 404");
  const oc = x.codeOf(opp.id);
  const os = await http("POST", SESSION, ip(63), { code: oc.code });
  const OPP: Who = bearer(String(os.json?.token));
  const oLu = await http("GET", LU(T2.id), OPP);
  const oTie = await http("GET", `/api/mobile/v1/coach/ties/${T2.id}`, OPP);
  check(os.status === 200 && oLu.status === 200 && (oLu.json?.entry as { submitted: unknown; side: string }).submitted === null && (oLu.json?.entry as { side: string }).side === oppSide, "the opponent's coach: its own empty form, never Egypt's submission", oLu.json?.entry);
  check(!EGYB.players.some((id) => oLu.text.includes(id) || oTie.text.includes(id)), "no Egypt player id anywhere in the opponent's line-up or tie", null);
  const otherTie = (await getTies(BOYS)).find((t) => t.team_a_id !== EGYB.id && t.team_b_id !== EGYB.id && t.team_a_id !== opp.id && t.team_b_id !== opp.id)!;
  const oth = await http("POST", LU(otherTie.id), C1, { lineup: good });
  const miss = await http("POST", LU(randomUUID()), C1, { lineup: good });
  check(oth.status === 404 && miss.status === 404 && oth.text === miss.text, "a submission for another team's tie: 404, same as a missing one", [oth.status, miss.status]);

  section("The officials see it prefilled and confirm it: locked, the coach can only view");
  const pick = await http("GET", `/api/mobile/v1/referee/matches/${r2[0].id}/lineup`, REF);
  const pc = (pick.json?.coach ?? {}) as Record<string, { pending: boolean; note: string; lineup: { S1: string } } | undefined>;
  check(pick.status === 200 && pc[egySide]?.pending === true && /^Submitted by the coach at \d\d:\d\d$/.test(pc[egySide]!.note) && pc[egySide]!.lineup.S1 === EGYB.players[1] && pc[oppSide] === undefined, "the chair umpire's picker: “Submitted by the coach at HH:MM”, prefilled; nothing for the other side", pick.json?.coach);
  const conf = await http("POST", `/api/mobile/v1/referee/matches/${r2[0].id}/lineup`, REF, {
    lineups: { [egySide]: swapped, [oppSide]: { S1: opp.players[0], S2: opp.players[1], D: [null, null] } },
    accept: [`${egySide}:${w[0]?.key}`],
  });
  check(conf.status === 200 && conf.json?.locked === true, "the chair umpire confirms the coach's line-up with the other side's: locked", [conf.status, conf.json?.error]);
  const ids = await egyRubberIds();
  check(ids.includes(EGYB.players[1]) && ids.includes(EGYB.players[0]), "the confirmed line-up is now in Egypt's rubbers", ids);
  const pick2 = await http("GET", `/api/mobile/v1/referee/matches/${r2[0].id}/lineup`, REF);
  check(((pick2.json?.coach ?? {}) as Record<string, { pending: boolean }>)[egySide]?.pending === false, "after confirming, the picker no longer offers it", pick2.json?.coach);
  const late = await http("POST", LU(T2.id), C1, { lineup: good });
  const luLocked = await http("GET", LU(T2.id), C1);
  const tieLocked = await http("GET", `/api/mobile/v1/coach/ties/${T2.id}`, C1);
  check(late.status === 409 && late.json?.code === "locked" && (luLocked.json?.entry as { open: boolean; closed: string }).closed === "locked" && (tieLocked.json?.lineupEntry as { open: boolean }).open === false, "locked: the coach's change is refused (409 locked) and the form is view only", [late.status, late.json?.code]);

  section("A deadline closes the coaches' entry; brakes");
  const sw2 = await callAction(ACTIONS, "saveCoachLineupSettingsAction", [form({ tournament_id: BOYS, event: BOYS, on: "on", deadline_minutes: "600" })], ADMIN);
  const dl = await http("POST", LU(T3.id), C1, { lineup: good });
  check(actionOk(sw2) && dl.status === 409 && dl.json?.code === "deadline", "a 10-hour deadline before a tie 5 hours away: 409 deadline", [dl.status, dl.json?.code]);
  await clearRequestCounters();
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await http("POST", LU(T3.id), C1, { lineup: good })).status;
  check(last === 429, "21 submissions from one sign-in within 10 minutes: braked (429)", last);
  await clearRequestCounters();

  section("Switched off again: refused and hidden");
  const sw3 = await callAction(ACTIONS, "saveCoachLineupSettingsAction", [form({ tournament_id: BOYS, event: BOYS, deadline_minutes: "" })], ADMIN);
  const offAgain = await http("POST", LU(T3.id), C1, { lineup: good });
  const pickOff2 = await http("GET", `/api/mobile/v1/referee/matches/${r2[0].id}/lineup`, REF);
  const luOff2 = await http("GET", LU(T3.id), C1);
  check(actionOk(sw3) && offAgain.status === 409 && offAgain.json?.code === "feature_off" && pickOff2.json?.coach === undefined && luOff2.json?.entry === undefined, "off: 409 feature_off, no entry, the picker shows nothing of coaches", [offAgain.status, offAgain.json?.code]);
}

async function main() {
  // Another script's failed sign-ins must not brake this one's (shared stand-in).
  await clearRequestCounters();
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;
  const ADMIN = staff("admin");

  /* ---------------- two tie events of one group ---------------- */
  const { data: g, error: ge } = await db().from("event_groups").insert({ slug: `e2e-coaches-${tag}`, name: `E2E Junior Finals ${tag}`, organization_id: MB, timezone: TZ }).select("id").single();
  if (ge) throw new Error(`event_groups: ${ge.message}`);
  made.group = (g as { id: string }).id;
  const BOYS = await f.tournament({ name: "Davis Juniors", sport: "tennis" });
  const GIRLS = await f.tournament({ name: "BJK Juniors", sport: "tennis" });
  await db()
    .from("tournaments")
    .update({ event_group_id: made.group, timezone: TZ, starts_on: today, ends_on: today, scoring_config: DEFAULT_TENNIS_SCORING_CONFIG, format_config: { ties: { rubbers: ["S2", "S1", "D"] }, qualifyPerGroup: 2 } })
    .in("id", [BOYS, GIRLS]);
  const [bc1, bc2] = await f.courts(BOYS, 2);
  await f.courts(GIRLS, 1);
  const setUp = async (tid: string, names: string[], codes: string[], ev: string) => {
    const r = await f.teams(tid, names, 4);
    for (const [i, t] of r.teams.entries()) {
      await db().from("teams").update({ nation_code: codes[i], team_name: `${names[i]} ${tag}` }).eq("id", t.id);
      for (const [j, pid] of t.players.entries()) await db().from("players").update({ full_name: `${codes[i]}${ev} Player${j + 1}` }).eq("id", pid);
    }
    return r.teams;
  };
  const bt = await setUp(BOYS, ["Egypt", "Spain", "Italy", "Japan"], ["EGY", "ESP", "ITA", "JPN"], "b");
  const gt = await setUp(GIRLS, ["Egypt", "France", "India", "Peru"], ["EGY", "FRA", "IND", "PER"], "g");
  const EGYB = bt[0];
  const EGYG = gt[0];
  /* ---------------- the draw makes the codes ---------------- */
  section("Confirming the draw makes a coach code for every team (once)");
  const mgr = await callAction(ACTIONS, "createCoachCodesAction", [form({ tournament_id: BOYS })], staff("manager"));
  const { count: none } = await db().from("coach_codes").select("id", { count: "exact", head: true }).in("tournament_id", [BOYS, GIRLS]);
  check(!actionOk(mgr) && none === 0, "a manager cannot make coach codes (admins only); none before the draw", mgr.status);
  const rb: DrawReport = {};
  const rg: DrawReport = {};
  await generateGroupTies(BOYS, "e2e", rb);
  await generateGroupTies(GIRLS, "e2e", rg);
  const countCodes = async () => (await db().from("coach_codes").select("id", { count: "exact", head: true }).in("tournament_id", [BOYS, GIRLS]).is("revoked_at", null)).count ?? 0;
  check(rb.coachCodesCreated === 4 && rg.coachCodesCreated === 4 && (await countCodes()) === 8, "generating each event's group ties makes a code for each of its four teams (8)", [rb.coachCodesCreated, rg.coachCodesCreated]);
  const again0: DrawReport = {};
  await generateGroupTies(BOYS, "e2e", again0);
  check(again0.coachCodesCreated === 0 && (await countCodes()) === 8, "confirming the boys' draw again makes none (never a second live code)", again0.coachCodesCreated);
  // A team added later gets its code when the ties are generated again: here through the admin's own button on the Ties page.
  const late = await f.teams(BOYS, [`Late ${tag}`], 4);
  const viaPage = await callAction("src/app/admin/tournaments/[id]/ties/actions.ts", "generateTiesAction", [form({ tournament_id: BOYS })], ADMIN, { id: BOYS });
  const { count: lateCodes } = await db().from("coach_codes").select("id", { count: "exact", head: true }).eq("team_id", late.teams[0].id).is("revoked_at", null);
  check((viaPage.status === 303 || viaPage.status === 200) && lateCodes === 1 && (await countCodes()) === 9 && /coachCodes=1/.test(viaPage.redirect ?? viaPage.text), "the Ties page's Generate makes one code for the team added later and says so", [viaPage.status, viaPage.redirect, lateCodes]);
  const notice = await http("GET", `/admin/tournaments/${BOYS}/ties?coachCodes=16`, ADMIN);
  check(notice.status === 200 && notice.text.includes('data-testid="coach-codes-notice"') && notice.text.includes("Coach codes created for 16 teams — print the cards") && notice.text.includes(`/qr/coaches?event=${BOYS}`), "the admin sees “Coach codes created for 16 teams — print the cards” with a link to the cards", notice.status);
  await db().from("teams").delete().eq("id", late.teams[0].id);
  await generateGroupTies(BOYS, "e2e");
  check((await countCodes()) === 8, "the late team removed: eight codes again (its code went with it)");
  const ties = await getTies(BOYS);
  const egyTies = ties.filter((t) => t.team_a_id === EGYB.id || t.team_b_id === EGYB.id);
  const otherTie = ties.find((t) => t.team_a_id !== EGYB.id && t.team_b_id !== EGYB.id)!;
  check(ties.length === 6 && egyTies.length === 3, "six boys' ties, three of them Egypt's", [ties.length, egyTies.length]);
  const T1 = egyTies[0];
  await scheduleTie(BOYS, otherTie.id, bc2, at("09:30"), "e2e");
  const rubbersOf = async (tie: Pick<Tie, "id">) => ((await db().from("matches").select("*").eq("tie_id", tie.id).order("rubber_no")).data ?? []) as Match[];

  /* ---------------- the admin: one click, a list, the cards ---------------- */
  section("Admin: the button covers both events (nothing new to make), the list, the cards");
  const mk = await callAction(ACTIONS, "createCoachCodesAction", [form({ tournament_id: BOYS })], ADMIN);
  check(actionOk(mk) && /made=0/.test(mk.redirect ?? mk.text), "\"Create a code for every team\" after the draw: nothing to make", `${mk.status} ${mk.redirect}`);
  const { data: codeRows } = await db().from("coach_codes").select("id, team_id, tournament_id, label, code_sealed, code_hash, expires_at").in("tournament_id", [BOYS, GIRLS]);
  const codes = (codeRows ?? []) as { id: string; team_id: string; tournament_id: string; label: string; code_sealed: string; code_hash: string; expires_at: string }[];
  check(codes.length === 8 && new Set(codes.map((c) => c.team_id)).size === 8, "one code per team, eight teams over both events", codes.length);
  check(codes.every((c) => Date.parse(c.expires_at) === Date.parse(at("23:59"))), "every code works until its event ends (23:59 Cairo)", codes.map((c) => c.expires_at));
  const again = await callAction(ACTIONS, "createCoachCodesAction", [form({ tournament_id: GIRLS })], ADMIN);
  const { count: still } = await db().from("coach_codes").select("id", { count: "exact", head: true }).in("tournament_id", [BOYS, GIRLS]);
  check(actionOk(again) && still === 8, "clicking again (from the girls' event) makes no second code", still);
  const codeOf = (teamId: string) => {
    const c = codes.find((x) => x.team_id === teamId)!;
    const plain = openEventCode(c.code_sealed)!;
    return { id: c.id, code: formatEventCode(plain), label: c.label, hashOk: hashEventCode(plain) === c.code_hash };
  };
  const CB = codeOf(EGYB.id);
  const CG = codeOf(EGYG.id);
  check(CB.hashOk && CB.code !== CG.code && /^Egypt .* · Davis Juniors/.test(CB.label) && /· BJK Juniors/.test(CG.label), "Egypt boys and Egypt girls have separate codes, labelled with their event", [CB.label, CG.label]);
  const page = await http("GET", `/admin/org/coaches?event=${BOYS}`, ADMIN);
  check(page.status === 200 && (page.text.match(/data-testid="coach-code-row"/g) ?? []).length === 8 && !page.text.includes(CB.code), "the Team coaches page lists the eight teams (never a code in the list)", page.status);
  const mgrPage = await http("GET", `/admin/org/coaches?event=${BOYS}`, staff("manager"));
  check(mgrPage.status !== 200 || !mgrPage.text.includes("coach-code-row"), "a manager does not get the Team coaches page", mgrPage.status);
  const cards = await http("GET", `/qr/coaches?event=${GIRLS}`, ADMIN);
  check(cards.status === 200 && (cards.text.match(/data-testid="coach-card"/g) ?? []).length === 8 && cards.text.includes(CB.code) && cards.text.includes("<svg"), "the printable cards: one per team, the QR and the code in text", cards.status);
  const one = await http("GET", `/qr/coaches?event=${BOYS}&team=${EGYG.id}`, ADMIN);
  check((one.text.match(/data-testid="coach-card"/g) ?? []).length === 1 && one.text.includes(CG.code), "one team's card on its own", one.status);
  const refCards = await http("GET", `/qr/coaches?event=${BOYS}`, staff("referee"));
  check(!refCards.text.includes(CB.code), "a referee cannot open the cards", refCards.status);
  check(cards.text.includes('data-testid="brand-band"') && cards.text.includes("/email/move-score-lockup@2x.png") && cards.text.includes("/brand/move-beyond-logo-white.png") && cards.text.includes("Move Score by Move Beyond · tour.mbeg.org") && cards.text.includes(`E2E Junior Finals ${tag}`), "the cards are branded: Move Score and Move Beyond logos, the event's name, the footer line", null);
  await db().from("tournaments").update({ branding_config: { sponsors: [{ name: "E2E Sponsor", logoUrl: "https://example.com/e2e-sponsor.png" }] }, app_skin: { seedA: "#c8102e" } }).eq("id", GIRLS);
  const sponsored = await http("GET", `/qr/coaches?event=${GIRLS}&team=${EGYG.id}`, ADMIN);
  check(sponsored.text.includes('data-testid="brand-sponsors"') && sponsored.text.includes("https://example.com/e2e-sponsor.png") && /#c8102e/i.test(sponsored.text), "an event's sponsors (small, at the foot) and colour on its cards", null);
  const png = await fetch(`${BASE_URL}/qr/coaches/share?event=${BOYS}&team=${EGYB.id}`, { headers: ADMIN });
  const pngBytes = Buffer.from(await png.arrayBuffer());
  const pngW = pngBytes.length > 24 ? pngBytes.readUInt32BE(16) : 0;
  const pngH = pngBytes.length > 24 ? pngBytes.readUInt32BE(20) : 0;
  check(png.status === 200 && png.headers.get("content-type") === "image/png" && pngBytes.subarray(1, 4).toString() === "PNG" && pngW === 1080 && pngH === 1350 && /no-store/.test(png.headers.get("cache-control") ?? "") && /attachment; filename="coach-card-/.test(png.headers.get("content-disposition") ?? ""), "Share: the team's card as a branded PNG, 1080×1350, private", [png.status, png.headers.get("content-type"), pngW, pngH, png.headers.get("cache-control")]);
  if (process.env.BRAND_OUT) (await import("node:fs")).writeFileSync(`${process.env.BRAND_OUT}/coach-share.png`, pngBytes);
  const pngOther = await http("GET", `/qr/coaches/share?event=${BOYS}&team=${randomUUID()}`, ADMIN);
  const pngMgr = await http("GET", `/qr/coaches/share?event=${BOYS}&team=${EGYB.id}`, staff("manager"));
  const pngRef = await http("GET", `/qr/coaches/share?event=${BOYS}&team=${EGYB.id}`, staff("referee"));
  const pngNone = await http("GET", `/qr/coaches/share?event=${BOYS}&team=${EGYB.id}`);
  check(pngOther.status === 404 && [401, 403].includes(pngMgr.status) && [401, 403].includes(pngRef.status) && pngNone.status === 401, "Share: an unknown team 404; a manager, a referee and nobody are refused", [pngOther.status, pngMgr.status, pngRef.status, pngNone.status]);
  const xlsx = await fetch(`${BASE_URL}/api/tournaments/${BOYS}/export`, { headers: ADMIN });
  const { default: ExcelJS } = await import("exceljs");
  const xwb = new ExcelJS.Workbook();
  await xwb.xlsx.load(await xlsx.arrayBuffer());
  const teamsWs = xwb.getWorksheet("Teams")!;
  check(xlsx.status === 200 && String(teamsWs.getRow(2).getCell(1).value).includes(`E2E Junior Finals ${tag}`) && String(teamsWs.getRow(3).getCell(1).value).includes("Move Score by Move Beyond · tour.mbeg.org") && String(teamsWs.getRow(4).getCell(1).value) === "Team" && teamsWs.getImages().length >= 2 && teamsWs.views[0]?.state === "frozen", "the tournament workbook is branded: logos, the event, the footer line, the header row frozen under them", [xlsx.status, teamsWs.getImages().length]);
  if (process.env.BRAND_OUT) (await import("node:fs")).writeFileSync(`${process.env.BRAND_OUT}/tournament-export.xlsx`, Buffer.from(await xwb.xlsx.writeBuffer()));
  check(parseCoachLink(coachLink(BASE_URL, CB.code)) === CB.code && new URL(coachLink(BASE_URL, CB.code)).pathname === "/c", "the card's QR is <site>/c#<code>");

  /* ---------------- signing in: two phones and the web, one code ---------------- */
  section("Egypt boys' coaches sign in: two phones and the web, the same code");
  const ph1 = await f.device("coach1");
  const ph2 = await f.device("coach2");
  const s1 = await http("POST", SESSION, { ...ip(11), "X-Install-Token": mintInstallToken(ph1.installationId) }, { code: CB.code.toLowerCase() });
  const s2 = await http("POST", SESSION, { ...ip(12), "X-Install-Token": mintInstallToken(ph2.installationId) }, { code: CB.code.replace(/-/g, "") });
  check(s1.status === 200 && s2.status === 200 && String(s1.json?.token).startsWith("mbc1.") && (s1.json?.team as { id: string }).id === EGYB.id, "both phones signed in as Egypt boys' coach", [s1.status, s2.status, s1.json?.team]);
  const C1: Who = bearer(String(s1.json?.token));
  const C2: Who = bearer(String(s2.json?.token));
  const { data: sess } = await db().from("coach_sessions").select("installation_id, ended_at").eq("code_id", CB.id);
  check((sess ?? []).length === 2 && [ph1.installationId, ph2.installationId].every((i) => (sess ?? []).some((s) => (s as { installation_id: string }).installation_id === i)), "two sign-ins, each with its phone", sess);
  const wrong = await http("POST", SESSION, ip(13), { code: "AAAA-BBBB-CCCC" });
  check(wrong.status === 401 && wrong.json?.code === "wrong_code", "a wrong code: 401 wrong_code", wrong.json);
  const asStaff = await http("POST", "/api/mobile/v1/staff/session", ip(14), { code: CB.code });
  check(asStaff.status === 401, "a coach code never signs in as staff", asStaff.status);
  const webIn = await callAction("src/app/coach/actions.ts", "coachSignInAction", [form({ code: CB.code })], ip(15));
  check(webIn.status === 303 || /\/coach\/team/.test(webIn.text), "web sign-in with the code goes to My team", webIn.status);
  const webBad = await callAction("src/app/coach/actions.ts", "coachSignInAction", [form({ code: "AAAA-BBBB-CCCC" })], ip(16));
  check(/wrong_code/.test(webBad.text) || webBad.status === 303, "web sign-in with a wrong code goes back with wrong_code", webBad.status);

  /* ---------------- line-ups (entered by the referee / organiser) ---------------- */
  section("Line-ups entered for Egypt's tie and another tie");
  const egySide: "A" | "B" = T1.team_a_id === EGYB.id ? "A" : "B";
  const oppId = egySide === "A" ? T1.team_b_id! : T1.team_a_id!;
  const opp = bt.find((t) => t.id === oppId)!;
  await setLineup(BOYS, T1.id, egySide, { S1: EGYB.players[0], S2: EGYB.players[1], D: [EGYB.players[2], EGYB.players[3]] }, "e2e");
  await setLineup(BOYS, T1.id, egySide === "A" ? "B" : "A", { S1: opp.players[0], S2: opp.players[1], D: [null, null] }, "e2e");
  const oA = bt.find((t) => t.id === otherTie.team_a_id)!;
  const oB = bt.find((t) => t.id === otherTie.team_b_id)!;
  await setLineup(BOYS, otherTie.id, "A", { S1: oA.players[0], S2: oA.players[1], D: [null, null] }, "e2e");
  await setLineup(BOYS, otherTie.id, "B", { S1: oB.players[0], S2: oB.players[1], D: [null, null] }, "e2e");
  await scheduleTie(BOYS, T1.id, bc1, new Date(Date.now() + 2 * 3600_000).toISOString(), "e2e");
  const lineupEv = await eventually(async () => {
    const { data } = await db().from("notification_events").select("kind, payload, fire_at, status").eq("tie_id", T1.id).like("kind", "coach_%");
    return (data ?? []) as { kind: string; payload: { title: string; body: string; targets: { kind: string; key: string }[] }; fire_at: string; status: string }[];
  }).then((r) => r);
  const lu = lineupEv.filter((e) => e.kind === "coach_lineup");
  const egyLu = lu.find((e) => e.payload.targets[0]?.key === EGYB.id);
  check(Boolean(egyLu) && /EGYb Player1/.test(egyLu!.payload.body) && !/ESPb|ITAb|JPNb/.test(JSON.stringify(egyLu!.payload)), "line-up alert to Egypt's coaches: their own players only", egyLu?.payload);
  const oppLu = lu.find((e) => e.payload.targets[0]?.key === oppId);
  check(lu.length === 2 && Boolean(oppLu) && !/EGYb/.test(JSON.stringify(oppLu!.payload)), "the opponent's coaches get their own line-up alert, which never names Egypt's players", lu.map((e) => [e.payload.targets[0]?.key, e.payload.body]));
  const soon = lineupEv.find((e) => e.kind === "coach_soon" && e.payload.targets[0]?.key === EGYB.id);
  check(Boolean(soon) && Math.abs(Date.parse(soon!.fire_at) - (Date.now() + 2 * 3600_000 - 5 * 60_000)) < 120_000 && soon!.status === "pending", "tie soon: queued for 5 minutes before the tie", soon);

  /* ---------------- My team ---------------- */
  section("My team: Egypt boys only");
  const team = await http("GET", "/api/mobile/v1/coach/team", C1);
  const v = team.json as unknown as import("../../src/lib/mobile/contract").MCoachTeamView;
  check(team.status === 200 && /no-store/.test(team.cache ?? ""), "GET coach/team: private, no-store", [team.status, team.cache]);
  check(v.team.id === EGYB.id && v.ties.length === 3 && v.ties.every((t) => egyTies.some((e) => e.id === t.id)), "three ties, all Egypt boys'", v.ties.map((t) => t.id));
  check(v.group?.rows.length === 4 && v.group.rows.some((r) => r.teamId === EGYB.id), "the group table (four teams)", v.group?.rows.length);
  const t1 = v.ties.find((t) => t.id === T1.id)!;
  check(t1.court === "Court 1" && Boolean(t1.scheduledTime) && t1.lineupEntered && t1.rubbers.every((r) => r.ours.length > 0), "Egypt's tie: court, time, its own line-up", { court: t1.court, entered: t1.lineupEntered });
  check(t1.rubbers.every((r) => r.theirs === null), "the opponents' line-up is not shown before the line-ups are confirmed (entered, not locked)", t1.rubbers.map((r) => r.theirs));
  check(!team.text.includes("ITAb Player") && !team.text.includes(`${opp.name.slice(0, 3).toUpperCase()}b Player`), "no other team's players anywhere in the payload", null);
  check(!/access_code|"phone"|"email"|referee/i.test(team.text), "no codes, phones, emails or referees in the payload");
  const slots = (i: number) => v.schedule.filter((s) => s.playerId === EGYB.players[i] && s.tieId === T1.id).map((s) => s.label);
  check(slots(0).join() === "No. 1 singles" && slots(1).join() === "No. 2 singles" && slots(2).join() === "Doubles" && slots(3).join() === "Doubles" && v.schedule.every((s) => s.court === "Court 1" || s.tieId !== T1.id), "players' schedule: who plays which rubber, on which court", [0, 1, 2, 3].map(slots));
  const team2 = await http("GET", "/api/mobile/v1/coach/team", C2);
  check(team2.status === 200, "the second phone reads it too", team2.status);
  const webBefore = await http("GET", `/coach/ties/${T1.id}`, coachCookie(String(s1.json?.token)));
  const oppName = String((await db().from("players").select("full_name").eq("id", opp.players[0]).single()).data?.full_name);
  check(webBefore.status === 200 && !webBefore.text.includes(oppName), "the web tie page does not name the opponents' players before confirmation", webBefore.status);

  section("Line-ups confirmed (locked by the referee): the opponents' players are shown");
  const lock = await lockLineups(BOYS, T1.id, "referee");
  check(lock.ok, "the chair umpire confirms (locks) the line-ups", lock);
  const afterLock = (await http("GET", "/api/mobile/v1/coach/team", C1)).json as unknown as import("../../src/lib/mobile/contract").MCoachTeamView;
  const t1c = afterLock.ties.find((t) => t.id === T1.id)!;
  const singles = t1c.rubbers.filter((r) => r.rubberType !== "D");
  const oppIdx = (r: { rubberType: string | null }) => (r.rubberType === "S1" ? 0 : 1);
  check(t1c.lineupLocked && singles.length === 2 && singles.every((r) => Array.isArray(r.theirs) && r.theirs.length === 1 && r.theirs[0].id === opp.players[oppIdx(r)]) && t1c.rubbers.every((r) => r.status === "scheduled"), "confirmed, not started: each singles rubber shows the opponent's player", singles.map((r) => [r.rubberType, r.status, r.theirs]));
  const dbl = t1c.rubbers.find((r) => r.rubberType === "D");
  check(Array.isArray(dbl?.theirs) && dbl!.theirs!.length === 0, "the opponents' doubles pair not named yet: shown as to be named (empty), never another tie's players", dbl?.theirs);
  const shownIds = afterLock.ties.flatMap((t) => t.rubbers.flatMap((r) => (r.theirs ?? []).map((p) => p.id)));
  check(shownIds.length === 2 && shownIds.every((id) => opp.players.includes(id)), "only this tie's opponents' players appear", shownIds);
  check(webAfter0(await http("GET", `/coach/ties/${T1.id}`, coachCookie(String(s1.json?.token))), oppName), "the web tie page names the opponent's player once confirmed");
  const unlockedTies = afterLock.ties.filter((t) => t.id !== T1.id);
  check(unlockedTies.every((t) => t.rubbers.every((r) => r.theirs === null)), "Egypt's other (unconfirmed) ties still hide the opponents", unlockedTies.map((t) => t.rubbers.map((r) => r.theirs)));
  const webAfter = await http("GET", `/coach/ties/${T1.id}`, coachCookie(String(s1.json?.token)));
  check(webAfter.status === 200 && webAfter.text.includes("Line-ups are confirmed"), "the web tie page says the line-ups are confirmed", webAfter.status);
  const lu1 = await http("GET", `/api/mobile/v1/coach/ties/${T1.id}/lineup`, C1);
  check(lu1.status === 200 && (lu1.json?.rubbers as { players: { id: string }[] }[]).every((r) => r.players.every((p) => EGYB.players.includes(p.id))), "coach/ties/:id/lineup: Egypt's own line-up only", lu1.json);

  section("Another team's tie, rubber, line-up and log: the same 404 as a missing one");
  const otherRubber = (await rubbersOf(otherTie))[0];
  const girlsTie = (await getTies(GIRLS)).find((t) => t.team_a_id === EGYG.id || t.team_b_id === EGYG.id)!;
  const missing = randomUUID();
  for (const [what, path, bad] of [
    ["tie", `/api/mobile/v1/coach/ties/${otherTie.id}`, `/api/mobile/v1/coach/ties/${missing}`],
    ["line-up", `/api/mobile/v1/coach/ties/${otherTie.id}/lineup`, `/api/mobile/v1/coach/ties/${missing}/lineup`],
    ["rubber", `/api/mobile/v1/coach/matches/${otherRubber.id}`, `/api/mobile/v1/coach/matches/${missing}`],
    ["log", `/api/mobile/v1/coach/matches/${otherRubber.id}/log`, `/api/mobile/v1/coach/matches/${missing}/log`],
    ["Egypt girls' tie", `/api/mobile/v1/coach/ties/${girlsTie.id}`, `/api/mobile/v1/coach/ties/not-a-uuid`],
  ] as const) {
    const a = await http("GET", path, C1);
    const b = await http("GET", bad, C1);
    check(a.status === 404 && b.status === 404 && a.text === b.text, `${what}: 404, same as missing`, [a.status, b.status]);
  }

  section("Staff routes refuse a coach token; coach routes are read only");
  const r0 = (await rubbersOf(T1))[0];
  for (const [method, path, body] of [
    ["GET", "/api/mobile/v1/referee/tournaments", undefined],
    ["GET", `/api/mobile/v1/referee/tournaments/${BOYS}/matches`, undefined],
    ["GET", `/api/mobile/v1/referee/matches/${r0.id}/bootstrap`, undefined],
    ["GET", `/api/mobile/v1/referee/matches/${r0.id}/lineup`, undefined],
    ["POST", `/api/mobile/v1/referee/matches/${r0.id}/lineup`, { lineups: { [egySide]: { S1: EGYB.players[3], S2: EGYB.players[2], D: [] } } }],
    ["POST", `/api/mobile/v1/referee/tournaments/${BOYS}/lineups/apply`, { rows: [] }],
    ["POST", `/api/matches/${r0.id}/events`, { deviceId: "coach", events: [] }],
    ["POST", `/api/matches/${r0.id}/claim`, { deviceId: "coach", deviceLabel: "x" }],
    ["POST", `/api/matches/${r0.id}/call`, { action: "call", deviceId: "coach" }],
    ["GET", `/api/matches/${r0.id}/log`, undefined],
    ["POST", "/api/mobile/v1/referee/assistance", { action: "request", matchId: r0.id }],
    ["GET", "/api/mobile/v1/referee/assistance", undefined],
    ["GET", "/api/mobile/v1/referee/notices", undefined],
  ] as const) {
    const r = await http(method, path, C1, body);
    check(r.status === 401 || r.status === 403, `${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}: refused (${r.status})`, r.text.slice(0, 120));
  }
  const adminAsCoach = await http("GET", "/admin/org/coaches", coachCookie(String(s1.json?.token)));
  check(adminAsCoach.status !== 200, "admin pages refuse a coach cookie", adminAsCoach.status);
  const post = await http("POST", `/api/mobile/v1/coach/ties/${T1.id}/lineup`, C1, { lineup: { S1: EGYB.players[3], S2: EGYB.players[2], D: [] } });
  check(post.status === 409 && post.json?.code === "feature_off", "POST coach/ties/:id/lineup while coach line-up entry is off: 409 feature_off (read only)", [post.status, post.json?.code]);
  const after = await rubbersOf(T1);
  check(JSON.stringify(after.map((m) => (egySide === "A" ? m.team_a_player_ids : m.team_b_player_ids))) === JSON.stringify((await rubbersOf(T1)).map((m) => (egySide === "A" ? m.team_a_player_ids : m.team_b_player_ids))) && after[0][egySide === "A" ? "team_a_player_ids" : "team_b_player_ids"]?.[0] === (r0.rubber_type === "S1" ? EGYB.players[0] : r0.rubber_type === "S2" ? EGYB.players[1] : EGYB.players[2]), "the line-up is unchanged", after.map((m) => m.team_a_player_ids));

  await coachLineupEntry({ BOYS, GIRLS, T2: egyTies[1]!, T3: egyTies[2]!, bc2, EGYB, bt, C1, C2, W: coachCookie(String(s1.json?.token)), codeOf, ADMIN, MB });

  /* ---------------- live: started, called, log, finished ---------------- */
  section("Live: the rubber starts, its log, called to court, finished");
  const dev = `desk-${tag}`;
  const S2R = after.find((m) => m.rubber_type === "S2")!;
  const call = await http("POST", `/api/matches/${S2R.id}/call`, ADMIN, { action: "call", deviceId: dev });
  check([200, 201].includes(call.status), "the desk calls Egypt's S2 to court", `${call.status} ${call.text.slice(0, 160)}`);
  const claim = await http("POST", `/api/matches/${S2R.id}/claim`, ADMIN, { deviceId: dev, deviceLabel: "Desk" });
  check(claim.status === 200, "the desk claims it to score", claim.status);
  const cfg = scoringConfigForMatch((await getTournament(BOYS))!, S2R, null, { doubles: false });
  const s0 = initialScoreState("A");
  const p1 = awardPoint(s0, "A", cfg);
  const p2 = awardPoint(p1, "B", cfg);
  const evs = await sendEvents(S2R.id, ADMIN, [scoreEvent(1, "MATCH_STARTED", null, s0, { payload: { first_server: "A" } }), scoreEvent(2, "POINT_AWARDED", s0, p1, { team_id: S2R.team_a_id }), scoreEvent(3, "POINT_AWARDED", p1, p2, { team_id: S2R.team_b_id })], dev);
  check(evs.status === 200, "start and two points are scored", evs.text.slice(0, 160));
  const live = await http("GET", `/api/mobile/v1/coach/matches/${S2R.id}`, C1);
  const lm = live.json as unknown as import("../../src/lib/mobile/contract").MCoachMatch;
  check(live.status === 200 && lm.rubber.status === "live" && Array.isArray(lm.rubber.theirs) && lm.rubber.theirs!.length === 1 && lm.rubber.ours[0].id === EGYB.players[1], "the live rubber: our player and, now it is under way, the opponent's", lm?.rubber);
  check(Boolean(lm.rubber.score?.points), "live score with the point score", lm?.rubber.score);
  check(lm.log.length >= 3 && !/"by"|Admin|admin|referee/i.test(JSON.stringify(lm.log)), "the match log, without who entered it", lm.log.map((e) => e.title));
  const log = await http("GET", `/api/mobile/v1/coach/matches/${S2R.id}/log`, C2);
  check(log.status === 200 && (log.json?.log as unknown[]).length === lm.log.length, "coach/matches/:id/log on the second phone", log.status);
  await finishDirect((await rubbersOf(T1)).find((m) => m.id === S2R.id)!, egySide);
  const kinds = await eventually(async () => {
    const { data } = await db().from("notification_events").select("kind, payload").eq("match_id", S2R.id).like("kind", "coach_%");
    const rows = (data ?? []) as { kind: string; payload: { targets: { key: string }[]; title: string } }[];
    const mine = rows.filter((r) => r.payload.targets[0]?.key === EGYB.id).map((r) => r.kind);
    return ["coach_called", "coach_started", "coach_finished"].every((k) => mine.includes(k)) ? rows : null;
  }, 8000);
  check(Boolean(kinds), "coach alerts for Egypt: called to court, started, finished", kinds?.map((k) => [k.kind, k.payload.title]));
  const won = kinds?.find((k) => k.kind === "coach_finished" && k.payload.targets[0]?.key === EGYB.id);
  check(Boolean(won) && /^Won: No\. 2 singles/.test(won!.payload.title), "the result reads from Egypt's side", won?.payload.title);

  section("Alerts reach both coach phones (dry run)");
  const { drainNotifications } = await import("../../src/lib/notify/drain");
  await db().from("notification_events").update({ fire_at: new Date().toISOString() }).eq("tie_id", T1.id).eq("kind", "coach_soon").eq("status", "pending");
  process.env.PUSH_DRY_RUN = "1";
  for (let i = 0; i < 4; i++) await drainNotifications(50);
  const { data: evRows } = await db().from("notification_events").select("id, kind, payload").eq("tournament_id", BOYS).like("kind", "coach_%");
  const egyEvents = ((evRows ?? []) as { id: string; kind: string; payload: { targets: { key: string }[] } }[]).filter((e) => e.payload.targets[0]?.key === EGYB.id);
  const { data: dl } = await db().from("notification_deliveries").select("event_id, device_id, status, ticket_id").in("event_id", egyEvents.map((e) => e.id));
  const deliveries = (dl ?? []) as { event_id: string; device_id: string; status: string; ticket_id: string }[];
  const sentTo = (k: string) => new Set(deliveries.filter((d) => egyEvents.find((e) => e.id === d.event_id)?.kind === k && d.status === "sent").map((d) => d.device_id));
  for (const k of ["coach_lineup", "coach_soon", "coach_called", "coach_started", "coach_finished"]) {
    const to = sentTo(k);
    check(to.has(ph1.id) && to.has(ph2.id), `${k}: sent to both coach phones (dry run)`, [...to]);
  }
  check(deliveries.every((d) => [ph1.id, ph2.id].includes(d.device_id) && (d.ticket_id ?? "").startsWith("dry-run")), "Egypt's coach alerts went to its coach phones only, nothing sent for real", deliveries.length);

  /* ---------------- the web view ---------------- */
  section("The web: /coach/team, a tie, a match, another team's tie");
  const W = coachCookie(String(s1.json?.token));
  const web = await http("GET", "/coach/team", W);
  check(web.status === 200 && web.text.includes('data-testid="coach-team"') && (web.text.match(/data-testid="coach-tie"/g) ?? []).length >= 3 && web.text.includes("coach-group"), "My team on the web: ties and the group table", web.status);
  const webTie = await http("GET", `/coach/ties/${T1.id}`, W);
  const webMatch = await http("GET", `/coach/matches/${S2R.id}`, W);
  const webOther = await http("GET", `/coach/ties/${otherTie.id}`, W);
  const webOtherM = await http("GET", `/coach/matches/${otherRubber.id}`, W);
  check(webTie.status === 200 && webMatch.status === 200 && webMatch.text.includes("coach-log"), "the tie and the match (with its log) open", [webTie.status, webMatch.status]);
  check(webOther.status === 404 && webOtherM.status === 404, "another team's tie and match: 404", [webOther.status, webOtherM.status]);
  const signedOut = await http("GET", "/coach/team");
  check(signedOut.status === 307 || signedOut.status === 303 || signedOut.status === 302, "no coach cookie: back to the sign-in", signedOut.status);

  /* ---------------- the QR page without the app ---------------- */
  section("The card's QR page without the app; AASA");
  const qr = await http("GET", "/c");
  check(qr.status === 200 && qr.text.includes('data-testid="coach-qr"') && qr.text.includes('data-testid="get-android"') && qr.text.includes('data-testid="get-ios"'), "/c: the download links", qr.status);
  check(!/set-cookie/i.test(qr.text) && !qr.text.includes(CB.code), "/c never signs in by itself and carries no code (it is in the #fragment)");
  const aasa = await http("GET", "/.well-known/apple-app-site-association");
  const paths = ((aasa.json?.applinks as { details: { paths: string[] }[] }).details[0]!.paths) ?? [];
  check(["/v/*", "/m/*", "/r", "/c"].every((p) => paths.includes(p)) && !paths.includes("/c/*") && !paths.includes("/*"), "AASA: /c beside 1.0.1's paths (exactly /c, so /coach stays in the browser)", paths);

  // Screenshots (optional): COACH_PAUSE_FILE=<path> writes what a browser needs to <path>.json
  // and waits (up to 10 minutes) until <path> is deleted.
  const pause = process.env.COACH_PAUSE_FILE;
  if (pause) {
    const { writeFileSync, existsSync } = await import("node:fs");
    const { sessionToken } = await import("./lib/session");
    writeFileSync(pause, "waiting");
    writeFileSync(`${pause}.json`, JSON.stringify({ admin: sessionToken("admin"), coach: String(s1.json?.token), event: BOYS, team: EGYB.id, tie: T1.id, match: S2R.id }));
    for (let i = 0; i < 600 && existsSync(pause); i++) await new Promise((r) => setTimeout(r, 1000));
  }

  /* ---------------- revoke, new code ---------------- */
  section("Revoking a code signs every device out; a new code replaces the old");
  const rv = await callAction(ACTIONS, "revokeCoachCodeAction", [form({ code_id: CB.id })], ADMIN);
  check(actionOk(rv), "revokeCoachCodeAction", rv.status);
  const a1 = await http("GET", "/api/mobile/v1/coach/team", C1);
  const a2 = await http("GET", "/api/mobile/v1/coach/team", C2);
  const aw = await http("GET", "/coach/team", W);
  check(a1.status === 401 && a1.json?.code === "code_revoked" && a2.status === 401 && aw.status !== 200, "both phones and the web are refused on their next request", [a1.status, a1.json?.code, a2.status, aw.status]);
  const again1 = await http("POST", SESSION, ip(17), { code: CB.code });
  check(again1.status === 401 && again1.json?.code === "code_revoked", "the revoked code no longer signs in", again1.json);
  const { data: ended } = await db().from("coach_sessions").select("ended_at").eq("code_id", CB.id);
  check((ended ?? []).every((s) => (s as { ended_at: string | null }).ended_at), "its sign-ins are ended (no more alerts)", ended);
  const gs = await http("POST", SESSION, ip(18), { code: CG.code });
  check(gs.status === 200 && (gs.json?.team as { id: string }).id === EGYG.id, "Egypt girls' code still works (a separate code)", gs.status);
  const regen = await callAction(ACTIONS, "regenerateCoachCodeAction", [form({ code_id: CG.id })], ADMIN);
  check(actionOk(regen), "regenerateCoachCodeAction", regen.status);
  const oldG = await http("GET", "/api/mobile/v1/coach/team", bearer(String(gs.json?.token)));
  const { data: newRow } = await db().from("coach_codes").select("id, code_sealed").eq("team_id", EGYG.id).is("revoked_at", null).single();
  const newCode = formatEventCode(openEventCode((newRow as { code_sealed: string }).code_sealed)!);
  const ns = await http("POST", SESSION, ip(19), { code: newCode });
  check(oldG.status === 401 && ns.status === 200 && newCode !== CG.code, "the old girls' code stops at once; the new one signs in", [oldG.status, ns.status]);

  /* ---------------- brakes ---------------- */
  section("Brakes on guessing: failed attempts only");
  await clearRequestCounters();
  for (let i = 0; i < 3; i++) await http("POST", SESSION, ip(40), { code: newCode });
  let last = 0;
  for (let i = 0; i < 20; i++) last = (await http("POST", SESSION, ip(40), { code: `ZZZZ-ZZZZ-ZZ${String(i).padStart(2, "2").replace(/[01]/g, "2")}` })).status;
  const locked = await http("POST", SESSION, ip(40), { code: newCode });
  const elsewhere = await http("POST", SESSION, ip(41), { code: newCode });
  check(last === 401 && locked.status === 429 && elsewhere.status === 200, "20 wrong codes from one address close it (right codes before did not count); another address still signs in", [last, locked.status, elsewhere.status]);
  await clearRequestCounters();
}

main()
  .catch((e) => {
    console.error(e);
    check(false, "script error", String(e));
  })
  .finally(async () => {
    if (made.referees.length) {
      await db().from("audit_logs").delete().in("actor_referee_id", made.referees);
      await db().from("audit_logs").delete().in("entity_id", made.referees);
      await db().from("referee_sessions").delete().in("referee_id", made.referees);
      await db().from("organization_codes").delete().in("referee_id", made.referees);
    }
    if (made.group) await db().from("organization_codes").delete().eq("event_group_id", made.group);
    if (made.referees.length) await db().from("referees").delete().in("id", made.referees);
    const ok = await f.cleanup();
    if (made.group) await db().from("event_groups").delete().eq("id", made.group);
    await clearRequestCounters();
    check(ok, "cleanup: everything made here is gone");
    finish("coaches");
  });
