/**
 * The match-day line-up sheet, server side: the downloadable template (one row per
 * tie, filled in with the day's ties and any players already named; a Squads sheet
 * with each nation's order of merit), reading an uploaded workbook, and the ties a
 * sheet may name (the page's event and the other tie events of its event group the
 * person reaches). Pure parts: lineupSheet.ts.
 */
import ExcelJS from "exceljs";
import { db } from "../supabase";
import type { StaffPrincipal } from "../auth/staff";
import { principalReaches, resolveEntity } from "../orgs/scope";
import type { RubberType, Tie } from "../types";
import { EVENT_TIME_ZONE, isoToZonedInput } from "./ties";
import { lineupOfRubbers, tieContext } from "./tieOps";
import { SHEET_COLUMNS, eventLabel, type SheetTie } from "./lineupSheet";
import type { Match } from "../types";

/** The tie events a sheet uploaded from this tournament's page may name: it, and its event group's other tie events the person reaches. */
export async function sheetTournaments(staff: StaffPrincipal, tournamentId: string): Promise<{ id: string; name: string }[]> {
  const { data: own } = await db().from("tournaments").select("id, name, event_group_id, organization_id, format_config").eq("id", tournamentId).eq("organization_id", staff.orgId).maybeSingle();
  const t = own as { id: string; name: string; event_group_id: string | null; organization_id: string; format_config: { ties?: unknown } | null } | null;
  if (!t) return [];
  let rows = [t];
  if (t.event_group_id) {
    const { data } = await db().from("tournaments").select("id, name, event_group_id, organization_id, format_config").eq("organization_id", staff.orgId).eq("event_group_id", t.event_group_id).eq("kind", "tournament").limit(20);
    rows = ((data ?? []) as (typeof t)[]).filter((x) => x.format_config?.ties);
    if (!rows.some((x) => x.id === t.id)) rows.unshift(t);
  }
  const out: { id: string; name: string }[] = [];
  for (const r of rows) {
    if (principalReaches(staff, await resolveEntity({ tournament: r.id }))) out.push({ id: r.id, name: r.name });
  }
  return out;
}

/** Every tie of those events with both nations known, as the sheet preview reads them. */
export async function sheetTies(tournaments: { id: string; name: string }[]): Promise<SheetTie[]> {
  const ids = tournaments.map((t) => t.id);
  if (!ids.length) return [];
  const [{ data: ties }, { data: matches }, { data: teams }, { data: players }, { data: courts }] = await Promise.all([
    db().from("ties").select("*").in("tournament_id", ids).order("tie_order"),
    db().from("matches").select("id, tie_id, rubber_type, status, winner_team_id, team_a_player_ids, team_b_player_ids").in("tournament_id", ids).not("tie_id", "is", null),
    db().from("teams").select("id, team_name, nation_code").in("tournament_id", ids),
    db().from("players").select("id, team_id, full_name, player_order").in("tournament_id", ids).order("player_order"),
    db().from("courts").select("id, court_name").in("tournament_id", ids),
  ]);
  const teamBy = new Map(((teams ?? []) as { id: string; team_name: string; nation_code: string | null }[]).map((t) => [t.id, t]));
  const courtBy = new Map(((courts ?? []) as { id: string; court_name: string }[]).map((c) => [c.id, c.court_name]));
  const squadOf = (teamId: string) => ((players ?? []) as { id: string; team_id: string; full_name: string }[]).filter((p) => p.team_id === teamId).map((p) => ({ id: p.id, name: p.full_name }));
  const nameOf = new Map(tournaments.map((t) => [t.id, t.name]));
  const out: SheetTie[] = [];
  for (const tie of (ties ?? []) as Tie[]) {
    if (!tie.team_a_id || !tie.team_b_id) continue;
    const rubbers = ((matches ?? []) as Match[]).filter((m) => m.tie_id === tie.id);
    const a = teamBy.get(tie.team_a_id);
    const b = teamBy.get(tie.team_b_id);
    const local = isoToZonedInput(tie.scheduled_time, EVENT_TIME_ZONE);
    const side = (s: "A" | "B") => ({ squad: squadOf(s === "A" ? tie.team_a_id! : tie.team_b_id!), lineup: lineupOfRubbers(rubbers, s), ...tieContext(rubbers, tie, s) });
    out.push({
      id: tie.id,
      tournamentId: tie.tournament_id,
      event: eventLabel(nameOf.get(tie.tournament_id) ?? ""),
      eventName: nameOf.get(tie.tournament_id) ?? "",
      label: `${a?.nation_code ?? a?.team_name ?? "?"} v ${b?.nation_code ?? b?.team_name ?? "?"}`,
      a: { teamId: tie.team_a_id, code: a?.nation_code ?? null, name: a?.team_name ?? "" },
      b: { teamId: tie.team_b_id, code: b?.nation_code ?? null, name: b?.team_name ?? "" },
      court: tie.court_id ? (courtBy.get(tie.court_id) ?? null) : null,
      day: local ? local.slice(0, 10) : null,
      time: local ? local.slice(11, 16) : null,
      status: tie.status,
      locked: Boolean(tie.lineup_locked_at),
      rubbers: rubbers.map((r) => ({ type: r.rubber_type as RubberType, status: r.status })),
      sides: { A: side("A"), B: side("B") },
    });
  }
  return out;
}

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B0B0B" } };

/** The template: the day's ties (or none), the players already named, and every squad in order of merit. */
export async function lineupTemplate(ties: SheetTie[], day: string | null): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Move Score";
  const ws = wb.addWorksheet("Line-ups", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = SHEET_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = HEADER_FILL;
  const todays = ties
    .filter((t) => t.status !== "completed" && (!day || t.day === day))
    .sort((x, y) => (x.day ?? "9").localeCompare(y.day ?? "9") || (x.time ?? "99").localeCompare(y.time ?? "99") || (x.court ?? "").localeCompare(y.court ?? "", "en", { numeric: true }));
  for (const t of todays) {
    const nameOf = (s: "A" | "B", id: string | null | undefined) => (id ? (t.sides[s].squad.find((p) => p.id === id)?.name ?? "") : "");
    const A = t.sides.A.lineup;
    const B = t.sides.B.lineup;
    ws.addRow({
      day: t.day ?? day ?? "",
      event: t.event,
      court: t.court ?? "",
      time: t.time ?? "",
      nationA: t.a.code ?? t.a.name,
      nationB: t.b.code ?? t.b.name,
      s1a: nameOf("A", A.S1),
      s1b: nameOf("B", B.S1),
      s2a: nameOf("A", A.S2),
      s2b: nameOf("B", B.S2),
      da1: nameOf("A", A.D[0]),
      da2: nameOf("A", A.D[1]),
      db1: nameOf("B", B.D[0]),
      db2: nameOf("B", B.D[1]),
    });
  }
  // Text cells: Excel must not turn "2026-11-02" or "09:30" into its own dates.
  for (const key of ["day", "time"]) ws.getColumn(key).numFmt = "@";

  const sq = wb.addWorksheet("Squads");
  sq.columns = [
    { header: "Event", key: "event", width: 10 },
    { header: "Nation", key: "nation", width: 14 },
    { header: "No.", key: "rank", width: 6 },
    { header: "Player", key: "player", width: 28 },
  ];
  sq.getRow(1).font = { bold: true };
  const seen = new Set<string>();
  for (const t of ties) {
    for (const [s, n] of [["A", t.a], ["B", t.b]] as const) {
      const key = `${t.tournamentId}:${n.teamId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      t.sides[s].squad.forEach((p, i) => sq.addRow({ event: t.event, nation: n.code ?? n.name, rank: i + 1, player: p.name }));
    }
  }

  const how = wb.addWorksheet("How to");
  how.getColumn(1).width = 110;
  for (const line of [
    "One row per tie. Type the players' names as they are in the Squads sheet (a last name alone is enough when it is unique; a squad number like No. 2 works too).",
    "S1 / S2: the singles players of each nation. The higher-ranked of the two in the order of merit plays S1 (ITF Reg. 43); a breach is shown as a warning to accept.",
    "D A1, D A2, D B1, D B2: the doubles pairs. Optional: leave them empty to name the pair after the singles.",
    "A nation's cells all empty: its line-up is left as it is. Changes to a locked line-up need a reason (ITF Reg. 46).",
    "Upload the file on the Ties page (or the master referee's desk): every name is checked against the squad before anything is saved.",
  ]) how.addRow([line]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A cell as the sheet's reader wants it: text; an Excel date as YYYY-MM-DD, a time as HH:MM. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // Excel keeps a time alone as a date on 30 Dec 1899; both are stored as UTC.
    if (v.getUTCFullYear() <= 1900) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);
    if ("text" in v) return String((v as { text: unknown }).text ?? "");
    return "";
  }
  return String(v);
}

/** The first sheet named "Line-ups" (or the first sheet) as a grid of texts. Throws on a file that is not a workbook. */
export async function readWorkbook(bytes: ArrayBuffer): Promise<(string | null)[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  const ws = wb.getWorksheet("Line-ups") ?? wb.worksheets[0];
  if (!ws) return [];
  const grid: (string | null)[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    if (n > 400) return;
    const cells: (string | null)[] = [];
    for (let c = 1; c <= Math.min(30, row.cellCount); c++) cells.push(cellText(row.getCell(c).value) || null);
    grid[n - 1] = cells;
  });
  return Array.from(grid, (r) => r ?? []);
}
