/**
 * The match-day line-up sheet (Excel), pure: its columns, reading a sheet's rows,
 * matching typed names against a nation's squad (with suggestions for close ones),
 * finding the tie a row is about, and checking each row the way setLineup will.
 * The workbook itself is read and written on the server (lineupSheetServer.ts,
 * exceljs); the preview table in the browser uses this module to re-check a row
 * live when the desk picks another player.
 *
 * One row per tie: Day, Event, Court, Time, Nation A, Nation B, S1 A, S1 B, S2 A,
 * S2 B, D A1, D A2, D B1, D B2. The doubles columns are optional (the pair is
 * usually named after the singles, Reg 43). A side whose cells are all empty is
 * left as it is; empty doubles cells keep whatever pair is named now.
 */
import type { RubberType } from "../types";
import { changedRubbers, checkLineup, doublesOf, needsReason, rubberEditable, type LineupCheck, type LineupDraft, type LineupIssue, type SquadMember, type StepRubber } from "./lineupRules";

export const SHEET_COLUMNS = [
  { key: "day", header: "Day", width: 12 },
  { key: "event", header: "Event", width: 10 },
  { key: "court", header: "Court", width: 10 },
  { key: "time", header: "Time", width: 8 },
  { key: "nationA", header: "Nation A", width: 14 },
  { key: "nationB", header: "Nation B", width: 14 },
  { key: "s1a", header: "S1 A", width: 22 },
  { key: "s1b", header: "S1 B", width: 22 },
  { key: "s2a", header: "S2 A", width: 22 },
  { key: "s2b", header: "S2 B", width: 22 },
  { key: "da1", header: "D A1", width: 22 },
  { key: "da2", header: "D A2", width: 22 },
  { key: "db1", header: "D B1", width: 22 },
  { key: "db2", header: "D B2", width: 22 },
] as const;

export type SheetKey = (typeof SHEET_COLUMNS)[number]["key"];
export type SheetRow = { line: number } & Record<SheetKey, string>;

/** The most rows one upload reads (a day of two events is about 20 ties). */
export const MAX_SHEET_ROWS = 200;

/** The player cells, by side and slot. */
export const PLAYER_CELLS = [
  { cell: "A.S1", key: "s1a", side: "A", slot: "S1" },
  { cell: "A.S2", key: "s2a", side: "A", slot: "S2" },
  { cell: "A.D1", key: "da1", side: "A", slot: "D1" },
  { cell: "A.D2", key: "da2", side: "A", slot: "D2" },
  { cell: "B.S1", key: "s1b", side: "B", slot: "S1" },
  { cell: "B.S2", key: "s2b", side: "B", slot: "S2" },
  { cell: "B.D1", key: "db1", side: "B", slot: "D1" },
  { cell: "B.D2", key: "db2", side: "B", slot: "D2" },
] as const;
export type CellId = (typeof PLAYER_CELLS)[number]["cell"];
type Slot = (typeof PLAYER_CELLS)[number]["slot"];

const headerKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const ALIASES: Record<string, SheetKey> = {
  ...Object.fromEntries(SHEET_COLUMNS.map((c) => [headerKey(c.header), c.key])),
  date: "day",
  notbefore: "time",
  nationa: "nationA",
  nationb: "nationB",
  home: "nationA",
  away: "nationB",
  singles1a: "s1a",
  singles1b: "s1b",
  singles2a: "s2a",
  singles2b: "s2b",
  doublesa1: "da1",
  doublesa2: "da2",
  doublesb1: "db1",
  doublesb2: "db2",
};

/**
 * The rows of a sheet given as a grid of cell texts. The header row is the first of
 * the top ten that names at least six of the columns; columns may be in any order.
 */
export function readSheet(grid: (string | null | undefined)[][]): { rows: SheetRow[]; error: string | null } {
  const top = grid.slice(0, 10);
  const at = top.findIndex((r) => r.filter((c) => c && ALIASES[headerKey(String(c))]).length >= 6);
  if (at < 0) return { rows: [], error: "No header row found. Use the template: Day, Event, Court, Time, Nation A, Nation B, S1 A … D B2." };
  const cols = new Map<SheetKey, number>();
  grid[at]!.forEach((c, i) => {
    const k = c ? ALIASES[headerKey(String(c))] : undefined;
    if (k && !cols.has(k)) cols.set(k, i);
  });
  for (const need of ["nationA", "nationB", "s1a", "s1b", "s2a", "s2b"] as SheetKey[]) {
    if (!cols.has(need)) return { rows: [], error: `The sheet has no "${SHEET_COLUMNS.find((c) => c.key === need)!.header}" column.` };
  }
  const rows: SheetRow[] = [];
  for (let i = at + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const row = { line: i + 1 } as SheetRow;
    for (const c of SHEET_COLUMNS) {
      const idx = cols.get(c.key);
      row[c.key] = idx === undefined ? "" : String(r[idx] ?? "").replace(/\s+/g, " ").trim();
    }
    if (!row.nationA && !row.nationB && PLAYER_CELLS.every((p) => !row[p.key])) continue;
    rows.push(row);
    if (rows.length > MAX_SHEET_ROWS) return { rows: [], error: `More than ${MAX_SHEET_ROWS} rows: upload one day at a time.` };
  }
  if (!rows.length) return { rows: [], error: "The sheet has no ties under its header row." };
  return { rows, error: null };
}

/* ---------------- names ---------------- */

/** "  José  Ñúñez-Smith " → "jose nunez smith": compared without case, accents or punctuation. */
export function normName(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

export interface NameMatch {
  raw: string;
  /** empty: nothing typed; exact: one squad player; close: a likely player (suggestions); unknown: nobody near. */
  status: "empty" | "exact" | "close" | "unknown";
  /** The player it reads as (exact), or the best suggestion (close). */
  id: string | null;
  suggestions: SquadMember[];
}

function forms(name: string): string[] {
  const t = normName(name).split(" ").filter(Boolean);
  if (!t.length) return [];
  const first = t[0]!;
  const last = t[t.length - 1]!;
  return [...new Set([t.join(" "), `${first} ${last}`, `${last} ${first}`, `${first[0]} ${last}`, `${last} ${first[0]}`])];
}

/**
 * A typed name against the squad. Exact: the full name, first and last name (either
 * order, or an initial), or a last or first name only when no one else shares it.
 * Close: within a couple of letters of a name (or a unique start of one), offered as
 * suggestions. A squad number ("1", "No. 1", "#2") reads as that place in the order of merit.
 */
export function matchPlayer(raw: string | null | undefined, squad: SquadMember[]): NameMatch {
  const text = String(raw ?? "").trim();
  if (!text) return { raw: text, status: "empty", id: null, suggestions: [] };
  const n = normName(text);
  const num = /^(?:no\.?\s*|#)?(\d{1,2})$/i.exec(text.trim());
  if (num) {
    const p = squad[Number(num[1]) - 1];
    return p ? { raw: text, status: "exact", id: p.id, suggestions: [] } : { raw: text, status: "unknown", id: null, suggestions: [] };
  }
  const exact = squad.filter((p) => forms(p.name).includes(n));
  if (exact.length === 1) return { raw: text, status: "exact", id: exact[0]!.id, suggestions: [] };
  if (exact.length > 1) return { raw: text, status: "close", id: exact[0]!.id, suggestions: exact };
  const tokenHits = squad.filter((p) => normName(p.name).split(" ").includes(n));
  if (tokenHits.length === 1) return { raw: text, status: "exact", id: tokenHits[0]!.id, suggestions: [] };
  if (tokenHits.length > 1) return { raw: text, status: "close", id: tokenHits[0]!.id, suggestions: tokenHits };

  const scored = squad
    .map((p) => {
      const full = normName(p.name);
      const parts = full.split(" ").filter(Boolean);
      const candidates = [...forms(p.name), ...parts.filter((x) => x.length >= 3)];
      let best = Math.min(...candidates.map((c) => editDistance(n, c) / Math.max(1, Math.min(c.length, 12))));
      // A unique start of a name ("Hass" for Hassan) is close.
      if (n.length >= 3 && parts.some((x) => x.startsWith(n))) best = Math.min(best, 0.1);
      return { p, best };
    })
    .filter((x) => x.best <= 0.34)
    .sort((a, b) => a.best - b.best);
  if (!scored.length) return { raw: text, status: "unknown", id: null, suggestions: [] };
  const suggestions = scored.slice(0, 3).map((x) => x.p);
  return { raw: text, status: "close", id: suggestions[0]!.id, suggestions };
}

/* ---------------- events, nations, ties ---------------- */

/** "Boys" / "Girls" for the Junior Finals' two events; otherwise the tournament's name. */
export function eventLabel(tournamentName: string): string {
  const n = normName(tournamentName);
  if (/\b(girls?|women|ladies|billie jean king|bjk)\b/.test(n)) return "Girls";
  if (/\b(boys?|men|davis)\b/.test(n)) return "Boys";
  return tournamentName;
}

export interface SheetNation {
  teamId: string;
  code: string | null;
  name: string;
}

/** What the preview needs to know about one tie. */
export interface SheetTie {
  id: string;
  tournamentId: string;
  event: string;
  eventName: string;
  label: string;
  a: SheetNation;
  b: SheetNation;
  court: string | null;
  /** The event zone's day ("2026-11-02") and time ("09:30"), or null. */
  day: string | null;
  time: string | null;
  status: "scheduled" | "live" | "completed";
  locked: boolean;
  rubbers: StepRubber[];
  sides: Record<"A" | "B", { squad: SquadMember[]; lineup: LineupDraft; retired: string[]; open: RubberType[] }>;
}

export const nationMatches = (raw: string, n: SheetNation) => {
  const x = normName(raw);
  return Boolean(x) && (x === normName(n.code) || x === normName(n.name));
};

const eventMatches = (raw: string, t: Pick<SheetTie, "event" | "eventName">) => {
  const x = normName(raw);
  if (!x) return true;
  return x === normName(t.event) || x === normName(t.eventName) || normName(t.eventName).includes(x) || (x.length === 1 && normName(t.event).startsWith(x));
};

/** "2026-11-02", from "2/11/2026", "02.11.2026", "2026-11-02"; day first (Cairo). Null when unreadable. */
export function sheetDay(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return null;
}

/**
 * The tie a row is about: its event (when given), its two nations in either order
 * (`swapped` when the sheet has them the other way round), then its day and court
 * when the pair meets more than once; an unfinished tie before a finished one.
 */
export function findTie(row: SheetRow, ties: SheetTie[]): { tie: SheetTie; swapped: boolean } | { error: string } {
  if (!row.nationA || !row.nationB) return { error: "Both nations are needed." };
  const inEvent = ties.filter((t) => eventMatches(row.event, t));
  if (!inEvent.length) return { error: `No event called "${row.event}".` };
  const hits = inEvent.flatMap((t) =>
    nationMatches(row.nationA, t.a) && nationMatches(row.nationB, t.b)
      ? [{ tie: t, swapped: false }]
      : nationMatches(row.nationA, t.b) && nationMatches(row.nationB, t.a)
        ? [{ tie: t, swapped: true }]
        : [],
  );
  if (!hits.length) return { error: `No tie ${row.nationA} v ${row.nationB}${row.event ? ` in ${row.event}` : ""}.` };
  const day = sheetDay(row.day);
  let pool = hits;
  if (pool.length > 1 && day) pool = pool.filter((h) => h.tie.day === day).length ? pool.filter((h) => h.tie.day === day) : pool;
  if (pool.length > 1 && row.court) pool = pool.filter((h) => normName(h.tie.court) === normName(row.court)).length ? pool.filter((h) => normName(h.tie.court) === normName(row.court)) : pool;
  if (pool.length > 1) pool = pool.filter((h) => h.tie.status !== "completed").length ? pool.filter((h) => h.tie.status !== "completed") : pool;
  const events = new Set(pool.map((h) => h.tie.tournamentId));
  if (events.size > 1) return { error: `${row.nationA} v ${row.nationB} is in more than one event: fill in the Event column.` };
  return pool[0]!;
}

/* ---------------- a row, checked ---------------- */

export interface PreviewRow {
  line: number;
  row: SheetRow;
  tie: Pick<SheetTie, "id" | "tournamentId" | "event" | "label" | "court" | "day" | "time" | "status" | "locked"> | null;
  error: string | null;
  swapped: boolean;
  /** Differences from the order of play worth a look (court, day), never blocking. */
  notes: string[];
  cells: Partial<Record<CellId, NameMatch>>;
}

/** Reads every row of a sheet against the ties it may name. */
export function previewSheet(rows: SheetRow[], ties: SheetTie[]): PreviewRow[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const found = findTie(row, ties);
    if ("error" in found) return { line: row.line, row, tie: null, error: found.error, swapped: false, notes: [], cells: {} };
    const { tie, swapped } = found;
    const notes: string[] = [];
    const twice = seen.get(tie.id);
    if (twice) return { line: row.line, row, tie: null, error: `The same tie as row ${twice}.`, swapped, notes, cells: {} };
    seen.set(tie.id, row.line);
    if (row.court && tie.court && normName(row.court) !== normName(tie.court)) notes.push(`The order of play has this tie on ${tie.court}, not ${row.court}.`);
    const day = sheetDay(row.day);
    if (day && tie.day && day !== tie.day) notes.push(`The order of play has this tie on ${tie.day}, not ${day}.`);
    const cells: PreviewRow["cells"] = {};
    for (const p of PLAYER_CELLS) {
      // The sheet's "A" is the tie's B when the nations are the other way round.
      const side = swapped ? (p.side === "A" ? "B" : "A") : p.side;
      cells[`${side}.${p.slot}` as CellId] = matchPlayer(row[p.key], tie.sides[side].squad);
    }
    return { line: row.line, row, tie: { id: tie.id, tournamentId: tie.tournamentId, event: tie.event, label: tie.label, court: tie.court, day: tie.day, time: tie.time, status: tie.status, locked: tie.locked }, error: null, swapped, notes, cells };
  });
}

/** The player picked for each cell: the match's id, unless the desk picked another. */
export type CellChoice = Partial<Record<CellId, string | null>>;

/** A side's line-up from a row, or null when the row leaves that side alone. */
export function draftFromRow(row: PreviewRow, side: "A" | "B", current: LineupDraft, choice: CellChoice = {}): LineupDraft | null {
  const pick = (slot: Slot): { typed: boolean; id: string | null } => {
    const cell = `${side}.${slot}` as CellId;
    const m = row.cells[cell];
    const id = cell in choice ? (choice[cell] ?? null) : (m?.id ?? null);
    return { typed: Boolean(m && m.status !== "empty") || cell in choice, id };
  };
  const s1 = pick("S1");
  const s2 = pick("S2");
  const d1 = pick("D1");
  const d2 = pick("D2");
  if (![s1, s2, d1, d2].some((x) => x.typed)) return null;
  const singlesTyped = s1.typed || s2.typed;
  const doublesTyped = d1.typed || d2.typed;
  return {
    S1: singlesTyped ? s1.id : current.S1,
    S2: singlesTyped ? s2.id : current.S2,
    D: doublesTyped ? [d1.id, d2.id] : [...(doublesOf(current) ?? [null, null])],
  };
}

export interface SideCheck extends LineupCheck {
  draft: LineupDraft | null;
  changed: RubberType[];
  /** A change after the line-ups were locked: needs the reason. */
  late: boolean;
}

/** A row checked side by side, as setLineup will check it (problems block, warnings need accepting). */
export function checkRow(row: PreviewRow, tie: SheetTie, choice: CellChoice = {}): Record<"A" | "B", SideCheck> {
  const out = {} as Record<"A" | "B", SideCheck>;
  for (const side of ["A", "B"] as const) {
    const s = tie.sides[side];
    const draft = draftFromRow(row, side, s.lineup, choice);
    if (!draft) {
      out[side] = { draft: null, changed: [], late: false, problems: [], warnings: [] };
      continue;
    }
    const check = checkLineup(draft, s.squad, { retired: s.retired, open: s.open });
    const changed = changedRubbers(s.lineup, draft);
    const problems: LineupIssue[] = [...check.problems];
    for (const t of changed) {
      const r = tie.rubbers.find((x) => x.type === t);
      if (r && !rubberEditable(r.status)) problems.push({ code: "not_in_squad", reg: null, message: `${t === "D" ? "The doubles" : `Singles ${t.slice(1)}`} is already under way; its players cannot change.`, rubbers: [t], key: `under_way:${t}` });
    }
    const warnings = check.warnings.filter((w) => w.rubbers.some((r) => changed.includes(r))).map((w) => ({ ...w, key: `${side}:${w.key}` }));
    out[side] = { draft, changed, late: needsReason(tie.locked, s.lineup, draft), problems, warnings };
  }
  return out;
}
