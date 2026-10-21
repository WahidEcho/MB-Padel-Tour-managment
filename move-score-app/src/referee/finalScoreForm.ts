/**
 * The final-score form's rows (FinalScore.tsx), kept free of React so they are
 * tested on their own. A row is one set as typed: the two sides' games next to
 * each other and, for a set that ended in a tie-break, the points of the side
 * that lost it (7-6(5) is typed 7, 6, 5: completeTiebreak fills in the winner's
 * 7). A match tie-break row is its two point totals (10-8). Every check is the
 * shared one (validateFinalScore via setKindAt), as on the server.
 */
import { completeTiebreak, matchTiebreakSet, setKindAt, type EnteredSet, type MatchRules, type SetKind } from "@core";
import { tr } from "../i18n/t";

export interface Row {
  a: string;
  b: string;
  /** The tie-break loser's points (a set that ended at the tie-break score). */
  tb: string;
}

export const EMPTY_ROW: Row = { a: "", b: "", tb: "" };

/** A typed score: whole numbers 0–99, anything else reads as invalid (-1). */
export function num(s: string): number {
  return /^\d{1,2}$/.test(s.trim()) ? parseInt(s.trim(), 10) : -1;
}

/** Digits only, at most two. */
export function digits(s: string): string {
  return s.replace(/\D/g, "").slice(0, 2);
}

const blank = (r: Row) => r.a.trim() === "" && r.b.trim() === "";

/** The set ended at the tie-break score (7-6 with a tie-break at 6-6), so its points are needed. */
export function needsTiebreak(rules: MatchRules, row: Pick<Row, "a" | "b">): boolean {
  if (!rules.tiebreakEnabled) return false;
  const a = num(row.a);
  const b = num(row.b);
  const t = rules.tiebreakAtGames;
  return (a === t + 1 && b === t) || (b === t + 1 && a === t);
}

/** The sets the rows say, up to the first empty row. */
export function setsFrom(rules: MatchRules, rows: Row[]): EnteredSet[] {
  const sets: EnteredSet[] = [];
  for (const row of rows) {
    if (blank(row)) break;
    if (setKindAt(rules, sets) === "match_tiebreak") {
      sets.push(matchTiebreakSet(num(row.a), num(row.b)));
      continue;
    }
    const s: EnteredSet = { a: num(row.a), b: num(row.b) };
    if (needsTiebreak(rules, row) && row.tb.trim() !== "") {
      const loser = num(row.tb);
      s.tb = loser < 0 ? { a: -1, b: -1 } : completeTiebreak(rules, s.a > s.b ? "A" : "B", loser);
    }
    sets.push(s);
  }
  return sets;
}

/** Rows to start from: a correction's (or a refused result's) sets, then empty rows up to the most a match can have. */
export function rowsFrom(rules: MatchRules, sets: EnteredSet[] | undefined, count: number): Row[] {
  const rows: Row[] = [];
  const prior: EnteredSet[] = [];
  for (const s of sets ?? []) {
    if (setKindAt(rules, prior) === "match_tiebreak" && s.tb) rows.push({ a: String(s.tb.a), b: String(s.tb.b), tb: "" });
    else rows.push({ a: String(s.a), b: String(s.b), tb: s.tb ? String(Math.min(s.tb.a, s.tb.b)) : "" });
    prior.push(s);
  }
  while (rows.length < count) rows.push({ ...EMPTY_ROW });
  return rows;
}

export interface RowView {
  index: number;
  kind: SetKind;
  label: string;
  /** Show the tie-break points field. */
  tiebreak: boolean;
  /** Whose tie-break points the field takes (the side that lost the set). */
  tiebreakLoser: "A" | "B" | null;
}

/** The rows on screen: each appears once the ones before it are filled, none after the match is won. */
export function visibleRows(rules: MatchRules, rows: Row[]): RowView[] {
  const out: RowView[] = [];
  for (let i = 0; i < rows.length; i++) {
    const prior = setsFrom(rules, rows.slice(0, i));
    if (i > 0 && prior.length < i) break;
    const won = (k: "a" | "b") => prior.filter((x) => (k === "a" ? x.a > x.b : x.b > x.a)).length;
    if (i > 0 && (won("a") >= rules.setsToWinMatch || won("b") >= rules.setsToWinMatch) && blank(rows[i])) break;
    const kind = setKindAt(rules, prior);
    const tiebreak = kind === "set" && needsTiebreak(rules, rows[i]);
    out.push({
      index: i,
      kind,
      label: kind === "match_tiebreak" ? tr("score.matchTiebreak") : tr("score.setN", { n: i + 1 }),
      tiebreak,
      tiebreakLoser: tiebreak ? (num(rows[i].a) > num(rows[i].b) ? "B" : "A") : null,
    });
  }
  return out;
}
