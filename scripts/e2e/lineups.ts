/**
 * Line-ups on match day (Junior Finals 2026), end to end on the stand-in: one tie
 * event of an event group, four nations of four players, Court 1 and Court 2, and
 *   - the Excel sheet: the template downloads with the day's ties; an upload previews
 *     every name against its squad (an unknown name red, a typo amber with its
 *     suggestion); Confirm saves through setLineup and locks the singles;
 *   - the court referee enters the singles alone (web picker route), then the doubles
 *     after the singles; no approval step;
 *   - an order-of-merit breach (ITF Reg. 43): refused until accepted; accepted by the
 *     court referee → the master referee's phone alerted (PUSH_DRY_RUN), the master's
 *     and the organiser's live banners, an audit row with the referee's name;
 *   - a change after entry needs a reason, by the court referee, the master referee
 *     and the organiser (admin action), each audited as a late change with who;
 *   - refusals: another court's referee, a whole-event referee password, another
 *     organisation, a court referee on the sheet routes, a sheet row of another
 *     organisation's event;
 *   - the regulation page; Move Score 1.0.1's bootstrap shows the nominated players.
 *
 *   npm run localdb                                              # another terminal
 *   npm run build && PUSH_DRY_RUN=1 npx next start -p 3077       # env from .env.localdb
 *   npm run e2e:lineups
 *
 * Creates and deletes its own data.
 */
import { randomUUID } from "crypto";
import ExcelJS from "exceljs";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { finalizeMatch, upsertSnapshotFromState } from "../../src/lib/ops";
import { getTournament } from "../../src/lib/data";
import { generateGroupTies, getTies, scheduleTie } from "../../src/lib/tennis/tieOps";
import { checkRow, type PreviewRow, type SheetTie } from "../../src/lib/tennis/lineupSheet";
import { formatEventCode, openEventCode } from "../../src/lib/orgs/codes";
import { mintInstallToken } from "../../src/lib/mobile/identity";
import { eventDay } from "../../src/lib/matchday/eventDay";
import { zonedToIso } from "../../src/lib/tennis/ties";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Match, type Tie } from "../../src/lib/types";
import { BASE_URL, assertStandIn, bearer, check, cookie, finish, fixtures, http, section, staff, type Who } from "./lib/fixtures";
import { actionOk, callAction, form } from "./lib/actions";

assertStandIn("lineups");

const tag = randomUUID().slice(0, 6);
const f = fixtures(tag);
const made = { group: null as string | null, referees: [] as string[] };
const TZ = "Africa/Cairo";
const today = eventDay(TZ);
const at = (hhmm: string) => zonedToIso(`${today}T${hhmm}`, TZ)!;
const ip = (n: number): Who => ({ "X-Forwarded-For": `198.51.100.${n}` });
const SESSION = "/api/mobile/v1/staff/session";
const shownState = (text: string, key: string) => new RegExp(`"${key}":"([^"]+)"`).exec(text)?.[1] ?? null;
const picker = (matchId: string) => `/api/mobile/v1/referee/matches/${matchId}/lineup`;

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

async function main() {
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;
  const ADMIN = staff("admin");

  /* ---------------- a tie event: four nations, two courts, today ---------------- */
  const { data: g, error: ge } = await db().from("event_groups").insert({ slug: `e2e-lineups-${tag}`, name: `E2E Line-ups ${tag}`, organization_id: MB, timezone: TZ }).select("id").single();
  if (ge) throw new Error(`event_groups: ${ge.message}`);
  made.group = (g as { id: string }).id;
  const BOYS = await f.tournament({ name: "Lineups Boys", sport: "tennis" });
  await db()
    .from("tournaments")
    .update({ event_group_id: made.group, timezone: TZ, starts_on: today, ends_on: today, scoring_config: DEFAULT_TENNIS_SCORING_CONFIG, format_config: { ties: { rubbers: ["S2", "S1", "D"] }, qualifyPerGroup: 2 } })
    .eq("id", BOYS);
  const [c1, c2] = await f.courts(BOYS, 2);
  const nations = await f.teams(BOYS, ["Egypt", "Spain", "Italy", "Japan"], 4);
  const codes = ["EGY", "ESP", "ITA", "JPN"];
  const first = ["Ali", "Omar", "Karim", "Youssef"];
  for (const [i, t] of nations.teams.entries()) {
    await db().from("teams").update({ nation_code: codes[i], team_name: `${["Egypt", "Spain", "Italy", "Japan"][i]} ${tag}` }).eq("id", t.id);
    for (const [j, pid] of t.players.entries()) await db().from("players").update({ full_name: `${first[j]} ${codes[i]![0]}${codes[i]!.slice(1).toLowerCase()}${["ardo", "bekov", "corral", "dunmore"][j]}` }).eq("id", pid);
  }
  await generateGroupTies(BOYS, "e2e");
  let ties = await getTies(BOYS);
  check(ties.length === 6, "six group ties generated", ties.length);
  await scheduleTie(BOYS, ties[0].id, c1, at("09:30"), "e2e");
  await scheduleTie(BOYS, ties[1].id, c2, at("09:30"), "e2e");
  await scheduleTie(BOYS, ties[2].id, c1, at("13:00"), "e2e");
  for (const t of ties.slice(3)) await scheduleTie(BOYS, t.id, c2, at("16:00"), "e2e");
  ties = await getTies(BOYS);
  const rubbers = async (tie: Tie) => {
    const { data } = await db().from("matches").select("*").eq("tie_id", tie.id).order("rubber_no");
    return (data ?? []) as Match[];
  };
  const squadOf = (teamId: string) => nations.teams.find((t) => t.id === teamId)!.players;
  const nameOf = async (pid: string) => ((await db().from("players").select("full_name").eq("id", pid).single()).data as { full_name: string }).full_name;
  const codeOf = (teamId: string) => codes[nations.teams.findIndex((t) => t.id === teamId)]!;

  /* ---------------- referees ---------------- */
  const addRef = async (name: string, role: "referee" | "master_referee") => {
    const r = await callAction("src/app/admin/org/referees/actions.ts", "createRefereeAction", [null, form({ name: `${name} ${tag}`, role, phone: "+20 100 000 0000", event_group_id: made.group! })], ADMIN);
    const pin = shownState(r.text, "pin");
    const { data } = await db().from("referees").select("id").eq("organization_id", MB).eq("name", `${name} ${tag}`).single();
    made.referees.push((data as { id: string }).id);
    return { id: (data as { id: string }).id, name: `${name} ${tag}`, pin: pin! };
  };
  const SARA = await addRef("Sara", "referee");
  const LINA = await addRef("Lina", "referee");
  const OMAR = await addRef("Omar", "master_referee");
  const cc = await callAction("src/app/admin/org/codes/courts/actions.ts", "createCourtCodesAction", [form({ tournament_id: BOYS, expires: "event_end" })], ADMIN);
  check(actionOk(cc), "court codes for both courts", cc.status);
  const { data: codeRows } = await db().from("organization_codes").select("court_name, code_sealed").eq("event_group_id", made.group);
  const courtCode = (court: string) => formatEventCode(openEventCode(((codeRows ?? []) as { court_name: string; code_sealed: string }[]).find((x) => x.court_name === court)!.code_sealed)!);
  const s1 = await http("POST", SESSION, ip(41), { code: courtCode("Court 1"), pin: SARA.pin });
  const REF1: Who = bearer(String(s1.json?.token));
  const REF1_WEB = cookie(String(s1.json?.token));
  const s2 = await http("POST", SESSION, ip(42), { code: courtCode("Court 2"), pin: LINA.pin });
  const REF2: Who = bearer(String(s2.json?.token));
  const mc = await callAction("src/app/admin/org/referees/actions.ts", "createMasterCodeAction", [null, form({ referee_id: OMAR.id, event_group_id: made.group!, expires_days: "7" })], ADMIN);
  const phone = await f.device("master");
  const install = mintInstallToken(phone.installationId);
  const ms = await http("POST", SESSION, { ...ip(43), "X-Install-Token": install }, { code: shownState(mc.text, "code"), pin: OMAR.pin });
  const MASTER: Who = { ...bearer(String(ms.json?.token)), "X-Install-Token": install };
  const MASTER_WEB = cookie(String(ms.json?.token));
  check(s1.status === 200 && s2.status === 200 && ms.status === 200, "Sara on Court 1, Lina on Court 2, Omar the master referee: signed in with their PINs", [s1.status, s2.status, ms.status]);
  await http("GET", "/api/mobile/v1/referee/assistance", MASTER); // records the master's phone for alerts

  /* ---------------- the Excel sheet ---------------- */
  section("The line-up sheet: template, preview, confirm");
  const tpl = await fetch(`${BASE_URL}/api/mobile/v1/referee/tournaments/${BOYS}/lineups/template?day=${today}`, { headers: ADMIN });
  const tplBytes = await tpl.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(tplBytes);
  const ws = wb.getWorksheet("Line-ups")!;
  const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  check(tpl.status === 200 && /spreadsheetml/.test(tpl.headers.get("content-type") ?? ""), "the template downloads as .xlsx", tpl.status);
  check(header.join("|") === "Day|Event|Court|Time|Nation A|Nation B|S1 A|S1 B|S2 A|S2 B|D A1|D A2|D B1|D B2", "…with the agreed columns", header.join("|"));
  check(ws.rowCount === 1 + 6, "…pre-filled with the day's six ties", ws.rowCount);
  check(Boolean(wb.getWorksheet("Squads")) && wb.getWorksheet("Squads")!.rowCount === 1 + 16, "…and a Squads sheet in order of merit", wb.getWorksheet("Squads")?.rowCount);
  const refTpl = await http("GET", `/api/mobile/v1/referee/tournaments/${BOYS}/lineups/template`, REF1);
  check(refTpl.status === 403, "a court referee cannot download the sheet (403)", refTpl.status);

  // Fill in ties 1 and 2 (Court 1 and Court 2, 09:30): one unknown name, one typo.
  const t0 = ties[0];
  const t1 = ties[1];
  const rowFor = (tie: Tie) => {
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const a = String(row.getCell(5).value ?? "");
      const b = String(row.getCell(6).value ?? "");
      if (a === codeOf(tie.team_a_id!) && b === codeOf(tie.team_b_id!) && String(row.getCell(4).value) === "09:30") return row;
    }
    throw new Error("row not found");
  };
  const A0 = squadOf(t0.team_a_id!);
  const B0 = squadOf(t0.team_b_id!);
  const A1 = squadOf(t1.team_a_id!);
  const B1 = squadOf(t1.team_b_id!);
  const r0 = rowFor(t0);
  r0.getCell(7).value = await nameOf(A0[0]); // S1 A
  r0.getCell(8).value = (await nameOf(B0[0])).split(" ")[1]; // S1 B: the last name alone
  r0.getCell(9).value = "Nobody Atall"; // S2 A: not in the squad
  r0.getCell(10).value = (await nameOf(B0[1])).slice(0, -1) + "x"; // S2 B: a typo
  const r1 = rowFor(t1);
  r1.getCell(7).value = await nameOf(A1[0]);
  r1.getCell(8).value = await nameOf(B1[0]);
  r1.getCell(9).value = await nameOf(A1[1]);
  r1.getCell(10).value = await nameOf(B1[1]);
  r1.getCell(11).value = await nameOf(A1[0]);
  r1.getCell(12).value = await nameOf(A1[2]);
  r1.getCell(13).value = await nameOf(B1[0]);
  r1.getCell(14).value = await nameOf(B1[2]);
  const filled = Buffer.from(await wb.xlsx.writeBuffer());
  const upload = async (who: Who, bytes: Buffer = filled) => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes)]), "line-ups.xlsx");
    const res = await fetch(`${BASE_URL}/api/mobile/v1/referee/tournaments/${BOYS}/lineups/preview`, { method: "POST", headers: who, body: fd });
    return { status: res.status, json: (await res.json().catch(() => null)) as { rows?: PreviewRow[]; ties?: SheetTie[]; error?: string } | null };
  };
  const prev = await upload(ADMIN);
  const rows = prev.json?.rows ?? [];
  const p0 = rows.find((r) => r.tie?.id === t0.id);
  const p1 = rows.find((r) => r.tie?.id === t1.id);
  check(prev.status === 200 && rows.length === 6 && Boolean(p0 && p1), "the upload previews every row against its tie", { status: prev.status, rows: rows.length, err: prev.json?.error });
  check(p0?.cells["A.S1"]?.status === "exact" && p0?.cells["B.S1"]?.status === "exact", "full and last-name-only names: matched", [p0?.cells["A.S1"]?.status, p0?.cells["B.S1"]?.status]);
  check(p0?.cells["A.S2"]?.status === "unknown", "an unknown name: red (unknown)", p0?.cells["A.S2"]);
  check(p0?.cells["B.S2"]?.status === "close" && p0?.cells["B.S2"]?.id === B0[1], "a typo: a close match with the right suggestion", p0?.cells["B.S2"]);
  const sheetTies = new Map((prev.json?.ties ?? []).map((t) => [t.id, t]));
  const blocked = checkRow(p0!, sheetTies.get(t0.id)!);
  check(blocked.A.problems.some((p) => p.code === "missing_s2"), "…which blocks the row until fixed", blocked.A.problems.map((p) => p.code));
  {
    // A zip bomb in .xlsx clothing (audit L6): a real workbook plus one part that inflates to 25 MB.
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(filled);
    zip.file("xl/media/padding.bin", Buffer.alloc(25 * 1024 * 1024));
    const bomb = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
    const big = await upload(ADMIN, bomb);
    check(bomb.length < 2 * 1024 * 1024 && big.status === 400 && (big.json as { code?: string } | null)?.code === "too_big", "a workbook that unpacks to more than 20 MB: 400 too_big, never parsed", { bytes: bomb.length, status: big.status, json: big.json });
  }
  const mUpload = await upload(MASTER_WEB);
  check(mUpload.status === 200, "the master referee can upload the sheet too (desk)", mUpload.status);
  const rUpload = await upload(REF1_WEB);
  check(rUpload.status === 403, "a court referee cannot (403)", rUpload.status);
  const desk = await http("GET", `/referee/tournaments/${BOYS}/desk`, MASTER_WEB);
  check(desk.status === 200 && desk.text.includes('data-testid="lineup-sheet"'), "the master's desk has the sheet upload", desk.status);
  const adminTies = await http("GET", `/admin/tournaments/${BOYS}/ties`, ADMIN);
  check(adminTies.status === 200 && adminTies.text.includes('data-testid="lineup-sheet"'), "the admin Ties page has it", adminTies.status);

  // The desk fixes the unknown name with the squad player and confirms.
  const fixed = checkRow(p0!, sheetTies.get(t0.id)!, { "A.S2": A0[1] });
  const fine = checkRow(p1!, sheetTies.get(t1.id)!);
  const payload = [
    { tieId: t0.id, tournamentId: BOYS, lineups: { A: fixed.A.draft, B: fixed.B.draft } },
    { tieId: t1.id, tournamentId: BOYS, lineups: { A: fine.A.draft, B: fine.B.draft } },
  ];
  const APPLY = `/api/mobile/v1/referee/tournaments/${BOYS}/lineups/apply`;
  const badRow = await http("POST", APPLY, ADMIN, { rows: [{ ...payload[0], lineups: { A: blocked.A.draft, B: blocked.B.draft } }] });
  check(badRow.status === 400 && badRow.json?.code === "problems", "confirming a row with a missing player: 400, nothing saved", badRow.json);
  const applied = await http("POST", APPLY, ADMIN, { rows: payload, accept: [] });
  check(applied.status === 200 && applied.json?.saved === 2 && applied.json?.locked === 2, "Confirm: both ties saved and their singles locked", applied.json);
  const rb0 = await rubbers(t0);
  check(rb0.find((r) => r.rubber_type === "S2")?.team_a_player_ids?.[0] === A0[1] && rb0.find((r) => r.rubber_type === "S2")?.team_b_player_ids?.[0] === B0[1], "the fixed name and the suggestion reached Singles 2", rb0.map((r) => [r.rubber_type, r.team_a_player_ids, r.team_b_player_ids]));
  const rb1 = await rubbers(t1);
  check(rb1.find((r) => r.rubber_type === "D")?.team_a_player_ids?.join() === [A1[0], A1[2]].join(), "the doubles columns, when given, name the pair", rb1.find((r) => r.rubber_type === "D")?.team_a_player_ids);
  const { data: lockRows } = await db().from("ties").select("id, lineup_locked_at").in("id", [t0.id, t1.id]);
  check(((lockRows ?? []) as { lineup_locked_at: string | null }[]).every((x) => x.lineup_locked_at), "…locked", lockRows);
  const { count: sheetAudits } = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("tournament_id", BOYS).eq("action", "LINEUP_SET");
  check((sheetAudits ?? 0) >= 4, "each side audited as LINEUP_SET", sheetAudits);
  // Another organisation's event in a sheet row: not found.
  const other = await f.otherOrgReferee();
  const { data: ot } = await db().from("tournaments").insert({ name: `Other ${tag}`, slug: `lineups-other-${tag}`, sport: "tennis", status: "active", is_demo: true, organization_id: other.orgId }).select("id").single();
  const OT = (ot as { id: string }).id;
  f.created.tournaments.push(OT);
  const foreign = await http("POST", APPLY, ADMIN, { rows: [{ ...payload[0], tournamentId: OT }] });
  check(foreign.status === 404, "a sheet row naming another organisation's event: 404", foreign.status);

  /* ---------------- the court referee: singles, then the doubles ---------------- */
  section("The court referee enters the line-ups alone");
  const t2 = ties[2];
  const rb2 = await rubbers(t2);
  const s2m = rb2.find((r) => r.rubber_type === "S2")!;
  const A2 = squadOf(t2.team_a_id!);
  const B2 = squadOf(t2.team_b_id!);
  const web = await http("GET", `/referee/matches/${s2m.id}/score`, REF1_WEB);
  check(web.status === 200 && web.text.includes('data-testid="lineup-picker"'), "web console: the rubber with no players opens the line-up picker", web.status);
  const g0 = await http("GET", picker(s2m.id), REF1);
  const sides = g0.json?.sides as Record<"A" | "B", { squad: { id: string; name: string }[] }> | undefined;
  check(g0.status === 200 && g0.json?.step === "singles" && sides?.A.squad.length === 4 && sides.A.squad[0].id === A2[0], "GET: step singles, the squad in order of merit", { status: g0.status, step: g0.json?.step });
  check(!/phone|email|access_code/.test(g0.text), "no private player column reaches the phone", g0.text.match(/phone|email|access_code/)?.[0]);
  const lina = await http("GET", picker(s2m.id), REF2);
  check(lina.status === 404, "another court's referee: 404", lina.status);
  const shared = await http("GET", picker(s2m.id), staff("referee"));
  check(shared.status === 403, "the shared referee password (not a court referee, master or organiser): 403", shared.status);
  const outsider = await http("GET", picker(s2m.id), other.who);
  check(outsider.status === 404 || outsider.status === 403, "another organisation's referee: refused", outsider.status);

  const breach = { A: { S1: A2[1], S2: A2[0], D: [null, null] }, B: { S1: B2[0], S2: B2[1], D: [null, null] } };
  const noAccept = await http("POST", picker(s2m.id), REF1, { lineups: breach });
  const w = ((noAccept.json?.warnings ?? []) as { key: string; code: string; message: string; reg: string }[])[0];
  check(noAccept.status === 409 && noAccept.json?.code === "warnings" && w?.code === "order_of_merit" && w.reg === "43", "No. 2 at Singles 1: 409, a Reg 43 warning to accept", noAccept.json);
  check(Boolean(w?.message.includes("(No. 1) is ranked above") && w.message.includes("should play Singles 1")), "…in plain words", w?.message);
  check((await rubbers(t2)).every((r) => !r.team_a_player_ids?.length), "…nothing saved");
  const ok = await http("POST", picker(s2m.id), REF1, { lineups: breach, accept: [w!.key] });
  check(ok.status === 200 && ok.json?.locked === true && ok.json?.alerted === 1, "accepted by the court referee: saved, singles locked, the master's phone alerted (dry run)", ok.json && { locked: ok.json.locked, alerted: ok.json.alerted, err: ok.json.error });
  const { data: exc } = await db().from("audit_logs").select("actor_name, actor_referee_id, new_value").eq("entity_id", t2.id).eq("action", "LINEUP_EXCEPTION_ACCEPTED");
  const excRow = ((exc ?? []) as { actor_name: string; actor_referee_id: string; new_value: { text: string } }[])[0];
  const expectText = `Referee ${SARA.name} accepted a line-up exception on Court 1: ${await nameOf(A2[1])} plays Singles 1 above ${await nameOf(A2[0])} (ITF Reg. 43)`;
  check(excRow?.actor_name === SARA.name && excRow.actor_referee_id === SARA.id && excRow.new_value.text === expectText, "audited with Sara's name and the agreed words", excRow?.new_value?.text);
  const mNotices = await http("GET", "/api/mobile/v1/referee/notices", MASTER);
  check(mNotices.status === 200 && ((mNotices.json?.notices ?? []) as { text: string }[]).some((n) => n.text === expectText), "the master referee's live banner has it", mNotices.json);
  const aNotices = await http("GET", "/api/mobile/v1/referee/notices", ADMIN);
  check(((aNotices.json?.notices ?? []) as { text: string }[]).some((n) => n.text === expectText), "the organiser's live banner has it", aNotices.json?.role);
  const rNotices = await http("GET", "/api/mobile/v1/referee/notices", REF2);
  check(rNotices.status === 200 && ((rNotices.json?.notices ?? []) as unknown[]).length === 0, "a court referee's list is empty", rNotices.json);
  const live = await http("GET", "/admin/org/referees/live", ADMIN);
  const liveText = live.text.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
  check(live.status === 200 && liveText.includes("lineup exception accepted") && liveText.includes(expectText), "the admin log (On court now) lists it with the words", live.status);

  // The singles are played; then the doubles pair.
  const after = await rubbers(t2);
  for (const r of after.filter((x) => x.rubber_type !== "D")) await finishDirect(r, "A");
  const g1 = await http("GET", picker(s2m.id), REF1);
  check(g1.json?.step === "doubles", "after the singles: step doubles", g1.json?.step);
  const singlesNow = { A: { S1: A2[1], S2: A2[0] }, B: { S1: B2[0], S2: B2[1] } };
  const dbl = await http("POST", picker(s2m.id), REF1, { lineups: { A: { ...singlesNow.A, D: [A2[2], A2[3]] }, B: { ...singlesNow.B, D: [B2[2], B2[3]] } } });
  check(dbl.status === 200 && (dbl.json?.picker as { step: string } | undefined)?.step === "done", "the doubles named by the court referee, no reason needed", dbl.json?.error ?? (dbl.json?.picker as { step: string } | undefined)?.step);
  const { count: dn } = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", t2.id).eq("action", "DOUBLES_NAMED").eq("actor_referee_id", SARA.id);
  check(dn === 2, "…recorded as the doubles named, by Sara", dn);

  /* ---------------- changes after entry, with a reason ---------------- */
  section("Changes after entry need a reason: court referee, master referee, organiser");
  const change = { A: { ...singlesNow.A, D: [A2[2], A2[1]] } };
  const noReason = await http("POST", picker(s2m.id), REF1, { lineups: change });
  check(noReason.status === 409 && noReason.json?.code === "reason", "court referee, a named pair changed without a reason: 409", noReason.json);
  const withReason = await http("POST", picker(s2m.id), REF1, { lineups: change, reason: "Cramp in the warm-up" });
  check(withReason.status === 200, "…with one: saved", withReason.json?.error);
  const s2t1 = (await rubbers(t1)).find((r) => r.rubber_type === "S2")!;
  const mChange = await http("POST", picker(s2t1.id), MASTER, { lineups: { A: { S1: A1[0], S2: A1[2], D: [A1[0], A1[2]] } }, reason: "No. 2 ill overnight" });
  check(mChange.status === 200, "master referee (Court 2 tie): a singles change with a reason", mChange.json?.error);
  const aChange = await callAction("src/app/admin/tournaments/[id]/ties/actions.ts", "saveLineupAction", [null, form({ tournament_id: BOYS, tie_id: t0.id, side: "B", S1: B0[0], S2: B0[2], D1: "", D2: "", reason: "Wrong player typed in the sheet" })], ADMIN, { id: BOYS });
  check(aChange.status === 200 && /"ok":true/.test(aChange.text), "organiser (admin Ties page): a change with a reason", aChange.text.slice(0, 200));
  const aNo = await callAction("src/app/admin/tournaments/[id]/ties/actions.ts", "saveLineupAction", [null, form({ tournament_id: BOYS, tie_id: t0.id, side: "B", S1: B0[0], S2: B0[3], D1: "", D2: "" })], ADMIN, { id: BOYS });
  check(/"ok":false/.test(aNo.text) && /locked/.test(aNo.text), "…and refused without one", aNo.text.slice(0, 200));
  const { data: lates } = await db().from("audit_logs").select("actor_name, entity_id, new_value").eq("tournament_id", BOYS).eq("action", "LINEUP_LATE_CHANGE");
  const lateRows = (lates ?? []) as { actor_name: string | null; entity_id: string; new_value: { reason: string } }[];
  check(
    lateRows.some((r) => r.actor_name === SARA.name && r.new_value.reason === "Cramp in the warm-up") &&
      lateRows.some((r) => r.actor_name === OMAR.name && r.new_value.reason === "No. 2 ill overnight") &&
      lateRows.some((r) => r.entity_id === t0.id && r.new_value.reason === "Wrong player typed in the sheet"),
    "three late changes audited, each with its reason and who",
    lateRows.map((r) => [r.actor_name, r.new_value.reason]),
  );
  const started = (await rubbers(t2)).find((r) => r.rubber_type === "S1")!;
  const tooLate = await http("POST", picker(started.id), REF1, { lineups: { A: { S1: A2[3], S2: A2[0], D: [A2[2], A2[1]] } }, reason: "x", accept: [`A:order_of_merit:${A2[3]}>${A2[0]}`] });
  check(tooLate.status === 409 && tooLate.json?.code === "under_way", "a finished rubber's players cannot change", tooLate.json);

  /* ---------------- the regulation page, Move Score 1.0.1 ---------------- */
  section("Regulation page; the old app sees the line-ups");
  const reg = await http("GET", "/regulations/itf-junior-team/43");
  check(reg.status === 200 && reg.text.includes('data-testid="itf-official"') && reg.text.includes("itftennis.com"), "/regulations/itf-junior-team/43: our summary and the official ITF button", reg.status);
  const boot = await http("GET", `/api/mobile/v1/referee/matches/${s2t1.id}/bootstrap`, REF2);
  const sideA = boot.json?.sideA as { players: { id: string }[] } | null;
  check(boot.status === 200 && boot.json?.waitingForLineups === null && sideA?.players.map((p) => p.id).join() === A1[2], "1.0.1's bootstrap shows the players the master named", boot.json?.sideA);
}

main()
  .catch((e) => check(false, "lineups threw", String(e?.stack ?? e)))
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
    await db().from("request_counters").delete().like("bucket_key", "staff-%");
    check(ok, "cleanup: every row made here is gone");
    finish("lineups");
  });
