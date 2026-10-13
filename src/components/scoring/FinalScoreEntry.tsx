"use client";

/**
 * Final-result entry (Phase 2), shared by the referee web console and the admin
 * matches page. Three steps, so a typo never reaches the standings:
 *
 *   1. enter      the two sides' scores next to each other, set by set (tie-break
 *                 points for a 7-6 set; a match tie-break as its points), checked
 *                 against the match's own rules as they are typed;
 *   2. summary    the result read back with the winner highlighted:
 *                 "Keep editing" or "Confirm";
 *   3. confirm    a second confirmation before it is recorded.
 *
 * Chess: win / draw / loss per game. A level knockout pairing asks the organiser
 * who advances (`canDecideAdvance`); anyone else records it level and the
 * organiser decides later.
 *
 * The parent sends the payload (resultEntry.ts) and shows the server's answer
 * through `error` / `problems`.
 */
import { useMemo, useState } from "react";
import type { MatchRules } from "@/lib/types";
import { finalScoreSummary, matchTiebreakSet, setKindAt, validateFinalScore, type EnteredSet } from "@/lib/scoring/finalScore";
import { buildResultState, type ResultPayload, type ResultProblem } from "@/lib/scoring/resultEntry";
import { chessOutcome, chessScoreLine, type ChessCompetition, type ChessGameResult, type Side } from "@/lib/chess/result";
import type { ScoreState } from "@/lib/scoring/engine";

export interface FinalScoreEntryProps {
  engine: "games" | "chess";
  rules: MatchRules;
  legs?: 1 | 2;
  competition?: ChessCompetition;
  sideA: string;
  sideB: string;
  /** What the form starts from (a correction starts from the recorded score). */
  initial?: ResultPayload | null;
  /** The match already has a score: entering a result replaces it (audited). */
  correcting?: boolean;
  /** Admin or manager: may pick who advances from a level chess knockout. */
  canDecideAdvance?: boolean;
  busy?: boolean;
  error?: string | null;
  problems?: ResultProblem[] | null;
  onSubmit: (payload: ResultPayload) => void;
  onCancel?: () => void;
}

interface Row {
  a: string;
  b: string;
  ta: string;
  tb: string;
}

type Step = "enter" | "summary" | "confirm";

const EMPTY: Row = { a: "", b: "", ta: "", tb: "" };

/** A typed score: whole numbers 0–99, anything else reads as invalid (-1). */
function num(s: string): number {
  return /^\d{1,2}$/.test(s.trim()) ? parseInt(s.trim(), 10) : -1;
}

function rowsFrom(rules: MatchRules, sets: EnteredSet[] | undefined, count: number): Row[] {
  const rows: Row[] = [];
  const prior: EnteredSet[] = [];
  for (const s of sets ?? []) {
    if (setKindAt(rules, prior) === "match_tiebreak" && s.tb) rows.push({ a: String(s.tb.a), b: String(s.tb.b), ta: "", tb: "" });
    else rows.push({ a: String(s.a), b: String(s.b), ta: s.tb ? String(s.tb.a) : "", tb: s.tb ? String(s.tb.b) : "" });
    prior.push(s);
  }
  while (rows.length < count) rows.push({ ...EMPTY });
  return rows.slice(0, Math.max(count, rows.length));
}

/** The sets the rows say, up to the first empty row. */
function setsFrom(rules: MatchRules, rows: Row[]): EnteredSet[] {
  const sets: EnteredSet[] = [];
  for (const row of rows) {
    if (row.a.trim() === "" && row.b.trim() === "") break;
    if (setKindAt(rules, sets) === "match_tiebreak") {
      sets.push(matchTiebreakSet(num(row.a), num(row.b)));
      continue;
    }
    const s: EnteredSet = { a: num(row.a), b: num(row.b) };
    if (row.ta.trim() !== "" || row.tb.trim() !== "") s.tb = { a: num(row.ta), b: num(row.tb) };
    sets.push(s);
  }
  return sets;
}

/** Whether a set row shows tie-break inputs: it ended at the tie-break score, or points were typed. */
function needsTiebreak(rules: MatchRules, row: Row): boolean {
  if (row.ta !== "" || row.tb !== "") return true;
  if (!rules.tiebreakEnabled) return false;
  const a = num(row.a);
  const b = num(row.b);
  const t = rules.tiebreakAtGames;
  return (a === t + 1 && b === t) || (b === t + 1 && a === t);
}

function ScoreInput({ value, onChange, label, testId }: { value: string; onChange: (v: string) => void; label: string; testId?: string }) {
  return (
    <input
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={2}
      aria-label={label}
      data-testid={testId}
      className="input w-14 px-1 py-2 text-center text-lg font-bold tabular-nums"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 2))}
    />
  );
}

export default function FinalScoreEntry(props: FinalScoreEntryProps) {
  const { engine, rules, sideA, sideB, correcting, canDecideAdvance, busy, error, problems: serverProblems, onSubmit, onCancel } = props;
  const legs = props.legs ?? 1;
  const competition = props.competition ?? "knockout";
  const maxSets = Math.max(1, 2 * rules.setsToWinMatch - 1);
  const [step, setStep] = useState<Step>("enter");
  const [rows, setRows] = useState<Row[]>(() =>
    rowsFrom(rules, props.initial && "sets" in props.initial ? props.initial.sets : undefined, maxSets),
  );
  const [games, setGames] = useState<(ChessGameResult | null)[]>(() => {
    const init = props.initial && "chess" in props.initial ? props.initial.chess : [];
    return Array.from({ length: legs }, (_, i) => init[i] ?? null);
  });
  const [advance, setAdvance] = useState<Side | null>(null);

  const sets = useMemo(() => setsFrom(rules, rows), [rules, rows]);
  const liveProblems = useMemo(() => (engine === "games" ? validateFinalScore(rules, sets) : []), [engine, rules, sets]);

  const payload: ResultPayload | null = useMemo(() => {
    if (engine === "games") return { sets };
    if (games.some((g) => g === null)) return null;
    const played = games as ChessGameResult[];
    // Who advances only means something for a level knockout pairing.
    const levelKnockout = competition === "knockout" && chessOutcome(played, competition).winner === null;
    return { chess: played, ...(advance && levelKnockout ? { advance } : {}) };
  }, [engine, sets, games, advance, competition]);

  const build = useMemo(
    () => (payload ? buildResultState({ engine, rules, payload: { ...payload, ...("chess" in payload ? { advance: null } : {}) }, competition, legs }) : null),
    [engine, rules, payload, competition, legs],
  );
  const chess = engine === "chess" && payload && "chess" in payload ? chessOutcome(payload.chess, competition) : null;
  const level = Boolean(build?.ok && build.engine === "chess" && build.level);
  const problems: ResultProblem[] = engine === "games" ? liveProblems : build && !build.ok ? build.problems : [];
  const ready = Boolean(build?.ok) && problems.length === 0 && (!level || !canDecideAdvance || advance !== null);
  const name = (k: Side) => (k === "A" ? sideA : sideB);

  const winner: Side | null = !build?.ok ? null : build.engine === "games" ? build.winner : level ? advance : build.winner;

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const serverBanner = (error || (serverProblems && serverProblems.length > 0)) && (
    <div className="rounded-xl bg-danger/15 px-3 py-2 text-sm text-danger" role="alert" data-testid="final-score-error">
      <p className="font-semibold">{error ?? "The result was not recorded."}</p>
      {serverProblems && serverProblems.length > 1 && (
        <ul className="mt-1 list-disc pl-4 text-xs">
          {serverProblems.map((p, i) => (
            <li key={i}>{p.message}</li>
          ))}
        </ul>
      )}
    </div>
  );

  /* ---------------- step 2 and 3: the result read back ---------------- */
  if (step !== "enter" && build?.ok) {
    const summary = build.engine === "games" ? finalScoreSummary(build.state as ScoreState) : null;
    return (
      <div className="space-y-3" data-testid="final-score-summary">
        {serverBanner}
        <h3 className="font-bold">{step === "summary" ? "Check the result" : correcting ? "Replace the recorded score?" : "Record this result?"}</h3>
        <div className="grid grid-cols-2 gap-2">
          {(["A", "B"] as Side[]).map((k) => {
            const won = winner === k;
            const count =
              summary ? (k === "A" ? summary.setsWon.a : summary.setsWon.b) : chess ? chessScoreLine(chess.points).split(" - ")[k === "A" ? 0 : 1] : "";
            return (
              <div
                key={k}
                className={`card space-y-1 text-center ${won ? "border-2 border-success bg-success/10" : "opacity-80"}`}
                data-testid={won ? "final-score-winner" : undefined}
              >
                <p className="truncate text-sm font-bold">{name(k)}</p>
                <p className="text-4xl font-bold tabular-nums">{count}</p>
                {won && <p className="text-xs font-bold uppercase tracking-widest text-success">Winner{level ? " · advances" : ""}</p>}
              </div>
            );
          })}
        </div>
        {summary && (
          <p className="text-center text-sm">
            <span className="font-semibold">{winner ? name(winner) : ""}</span> wins <span className="font-mono">{summary.setsWinnerFirst}</span>
          </p>
        )}
        {chess && (
          <p className="text-center text-sm">
            {chessScoreLine(chess.points)}
            {level && !advance && <span className="block text-xs text-warning">Level: the organiser decides who advances. The match stays open until then.</span>}
          </p>
        )}
        {step === "summary" ? (
          <div className="flex gap-2">
            <button type="button" className="btn-secondary flex-1 justify-center" onClick={() => setStep("enter")} data-testid="final-score-keep-editing">
              Keep editing
            </button>
            <button type="button" className="btn-primary flex-1 justify-center" onClick={() => setStep("confirm")} data-testid="final-score-confirm">
              Confirm
            </button>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted">
              {correcting
                ? "The score recorded so far is replaced and the change is logged. "
                : ""}
              Standings, the draw, points and the screens update straight away.
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1 justify-center" onClick={() => setStep("enter")} disabled={busy}>
                Back
              </button>
              <button
                type="button"
                className="btn-primary flex-1 justify-center"
                disabled={busy || !payload}
                onClick={() => payload && onSubmit(payload)}
                data-testid="final-score-record"
              >
                {busy ? "Recording…" : correcting ? "Replace result" : "Record result"}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  /* ---------------- step 1: enter ---------------- */
  return (
    <div className="space-y-3" data-testid="final-score-entry">
      {serverBanner}
      <h3 className="font-bold">{correcting ? "Correct the result" : "Enter the final result"}</h3>
      {correcting && <p className="text-xs text-warning">This match already has a score. The result you enter replaces it, and the change is logged.</p>}

      {engine === "games" ? (
        <div className="space-y-2">
          <div className="grid grid-cols-[4rem_1fr_1fr] items-end gap-2 text-center text-xs font-semibold text-muted">
            <span />
            <span className="truncate">{sideA}</span>
            <span className="truncate">{sideB}</span>
          </div>
          {rows.map((row, i) => {
            const prior = setsFrom(rules, rows.slice(0, i));
            // Rows only appear once the ones before them are filled.
            if (i > 0 && prior.length < i) return null;
            const kind = setKindAt(rules, prior);
            const tb = kind === "set" && needsTiebreak(rules, row);
            return (
              <div key={i} className="space-y-1">
                <div className="grid grid-cols-[4rem_1fr_1fr] items-center gap-2">
                  <span className="text-xs font-semibold text-muted">{kind === "match_tiebreak" ? "Match TB" : `Set ${i + 1}`}</span>
                  <div className="flex justify-center">
                    <ScoreInput value={row.a} onChange={(v) => setRow(i, { a: v })} label={`${sideA} ${kind === "match_tiebreak" ? "match tie-break points" : `set ${i + 1} games`}`} testId={`fs-${i}-a`} />
                  </div>
                  <div className="flex justify-center">
                    <ScoreInput value={row.b} onChange={(v) => setRow(i, { b: v })} label={`${sideB} ${kind === "match_tiebreak" ? "match tie-break points" : `set ${i + 1} games`}`} testId={`fs-${i}-b`} />
                  </div>
                </div>
                {tb && (
                  <div className="grid grid-cols-[4rem_1fr_1fr] items-center gap-2">
                    <span className="text-[11px] text-muted">Tie-break</span>
                    <div className="flex justify-center">
                      <ScoreInput value={row.ta} onChange={(v) => setRow(i, { ta: v })} label={`${sideA} set ${i + 1} tie-break points`} testId={`fs-${i}-ta`} />
                    </div>
                    <div className="flex justify-center">
                      <ScoreInput value={row.tb} onChange={(v) => setRow(i, { tb: v })} label={`${sideB} set ${i + 1} tie-break points`} testId={`fs-${i}-tb`} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[11px] text-muted">
            A 7-6 set needs its tie-break points. A match tie-break is entered as its points (10-8).
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {games.map((g, i) => {
            const white = i % 2 === 0 ? sideA : sideB;
            return (
              <div key={i} className="space-y-1">
                <p className="text-xs font-semibold text-muted">
                  Game {i + 1} · {white} has White
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {(["A", "draw", "B"] as ChessGameResult[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={g === r ? "btn-primary justify-center" : "btn-secondary justify-center"}
                      onClick={() => setGames((gs) => gs.map((x, j) => (j === i ? r : x)))}
                      data-testid={`chess-${i}-${r}`}
                    >
                      {r === "draw" ? "Draw" : `${name(r as Side)} won`}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {level && canDecideAdvance && (
            <div className="space-y-1" data-testid="chess-advance">
              <p className="text-xs font-semibold text-warning">The pairing is level. Who advances?</p>
              <div className="grid grid-cols-2 gap-2">
                {(["A", "B"] as Side[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={advance === k ? "btn-primary justify-center" : "btn-secondary justify-center"}
                    onClick={() => setAdvance(k)}
                    data-testid={`chess-advance-${k}`}
                  >
                    {name(k)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {level && !canDecideAdvance && (
            <p className="text-xs text-warning">The pairing is level: it is recorded as level and the organiser decides who advances.</p>
          )}
        </div>
      )}

      {problems.length > 0 && (sets.length > 0 || engine === "chess") && (
        <ul className="space-y-0.5 text-xs text-warning" data-testid="final-score-problems">
          {problems.slice(0, 3).map((p, i) => (
            <li key={i}>{p.message}</li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        {onCancel && (
          <button type="button" className="btn-secondary flex-1 justify-center" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn-primary flex-1 justify-center"
          disabled={!ready || busy}
          onClick={() => setStep("summary")}
          data-testid="final-score-check"
        >
          Check result
        </button>
      </div>
    </div>
  );
}
