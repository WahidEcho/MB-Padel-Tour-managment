"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { checkRow, type CellChoice, type CellId, type NameMatch, type PreviewRow, type SheetTie } from "@/lib/tennis/lineupSheet";
import { IssueText, RegLink } from "./RegLink";

const CELL_ORDER: CellId[] = ["A.S1", "B.S1", "A.S2", "B.S2", "A.D1", "A.D2", "B.D1", "B.D2"];
const CELL_HEAD: Record<CellId, string> = { "A.S1": "S1 A", "B.S1": "S1 B", "A.S2": "S2 A", "B.S2": "S2 B", "A.D1": "D A1", "A.D2": "D A2", "B.D1": "D B1", "B.D2": "D B2" };

const tone = (m: NameMatch | undefined, chosen: string | null, picked: boolean) => {
  if (!m || m.status === "empty") return picked && chosen ? "border-accent" : "border-border";
  if (picked) return chosen ? "border-accent bg-accent/10" : "border-danger bg-danger/15";
  if (m.status === "exact") return "border-success/60";
  if (m.status === "close") return "border-warning bg-warning/15";
  return "border-danger bg-danger/15";
};

/**
 * The match-day line-up sheet (admin Ties page and the master referee's desk):
 * download the template (the day's ties, filled in with what is named), upload it
 * filled in, check the preview (every name matched against that nation's squad: red
 * for unknown, amber with a suggestion for a close one, ITF warnings below with their
 * regulation links), then Confirm. Nothing is saved before Confirm, and the server
 * checks every row again. Routes: /api/mobile/v1/referee/tournaments/[id]/lineups/*.
 */
export default function LineupSheet({ tournamentId, defaultDay }: { tournamentId: string; defaultDay: string }) {
  const router = useRouter();
  const base = `/api/mobile/v1/referee/tournaments/${tournamentId}/lineups`;
  const [day, setDay] = useState(defaultDay);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [ties, setTies] = useState<SheetTie[]>([]);
  const [choices, setChoices] = useState<Record<number, CellChoice>>({});
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<null | "upload" | "apply">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const tieBy = useMemo(() => new Map(ties.map((t) => [t.id, t])), [ties]);
  const checked = useMemo(
    () =>
      (rows ?? []).map((r) => {
        const tie = r.tie ? tieBy.get(r.tie.id) : undefined;
        return { row: r, tie, check: tie ? checkRow(r, tie, choices[r.line] ?? {}) : null };
      }),
    [rows, tieBy, choices],
  );
  const problems = checked.flatMap(({ row, check }) => (check ? (["A", "B"] as const).flatMap((s) => check[s].problems.map((p) => ({ line: row.line, side: s, issue: p }))) : []));
  const warnings = checked.flatMap(({ row, tie, check }) =>
    check && tie ? (["A", "B"] as const).flatMap((s) => check[s].warnings.map((w) => ({ line: row.line, nation: s === "A" ? tie.a.code ?? tie.a.name : tie.b.code ?? tie.b.name, issue: w }))) : [],
  );
  const rowErrors = checked.filter(({ row }) => row.error);
  const late = checked.some(({ check }) => check && (check.A.late || check.B.late));
  const changes = checked.filter(({ check }) => check && (check.A.changed.length || check.B.changed.length));
  const pending = warnings.filter((w) => !accepted.has(w.issue.key));
  const canConfirm = !busy && rows !== null && changes.length > 0 && problems.length === 0 && pending.length === 0 && (!late || reason.trim().length > 0);

  const upload = async () => {
    if (!file) return;
    setBusy("upload");
    setError(null);
    setDone(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${base}/preview`, { method: "POST", body: fd });
      const body = (await res.json().catch(() => ({}))) as { error?: string; rows?: PreviewRow[]; ties?: SheetTie[] };
      if (!res.ok || !body.rows) {
        setError(body.error ?? "The sheet could not be read.");
        setRows(null);
        return;
      }
      setRows(body.rows);
      setTies(body.ties ?? []);
      setChoices({});
      setAccepted(new Set());
    } catch {
      setError("No connection: the sheet was not checked.");
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    setBusy("apply");
    setError(null);
    try {
      const payload = changes.map(({ row, check }) => ({
        tieId: row.tie!.id,
        tournamentId: row.tie!.tournamentId,
        lineups: Object.fromEntries((["A", "B"] as const).filter((s) => check![s].draft && check![s].changed.length).map((s) => [s, check![s].draft])),
      }));
      const res = await fetch(`${base}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload, accept: [...accepted], reason: reason.trim() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; saved?: number; locked?: number; exceptions?: number; failed?: { message: string }[] };
      if (!res.ok) {
        setError(body.error ?? "Nothing was saved. Check the rows and try again.");
        return;
      }
      setDone(
        `Saved ${body.saved ?? 0} tie${body.saved === 1 ? "" : "s"}${body.locked ? `; singles locked on ${body.locked}` : ""}${body.exceptions ? `; ${body.exceptions} exception${body.exceptions === 1 ? "" : "s"} accepted (the master referees were told)` : ""}.${body.failed?.length ? ` Not saved: ${body.failed.map((f) => f.message).join(" ")}` : ""}`,
      );
      setRows(null);
      setFile(null);
      router.refresh();
    } catch {
      setError("No connection: nothing was saved.");
    } finally {
      setBusy(null);
    }
  };

  const choose = (line: number, cell: CellId, id: string | null) => setChoices((c) => ({ ...c, [line]: { ...(c[line] ?? {}), [cell]: id } }));

  return (
    <section className="card space-y-3" data-testid="lineup-sheet">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="font-bold">Line-ups from Excel</h3>
          <p className="text-xs text-muted">One row per tie: the singles (and, if known, the doubles) of both nations. Checked against the squads before anything is saved.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="label">Day</span>
            <input type="date" className="input py-1" value={day} onChange={(e) => setDay(e.target.value)} />
          </label>
          <a href={`${base}/template?day=${encodeURIComponent(day || "all")}`} className="btn-secondary text-xs" data-testid="sheet-template">⬇ Download the template</a>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs" data-testid="sheet-file" />
        <button type="button" className="btn-primary text-xs" disabled={!file || busy !== null} onClick={() => void upload()} data-testid="sheet-upload">
          {busy === "upload" ? "Checking…" : "Upload and check"}
        </button>
      </div>

      {rows && (
        <div className="space-y-3" data-testid="sheet-preview">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-separate border-spacing-1 text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th>Row</th>
                  <th>Tie</th>
                  {CELL_ORDER.map((c) => (
                    <th key={c}>{CELL_HEAD[c]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {checked.map(({ row, tie }) => (
                  <tr key={row.line} className="align-top" data-testid="sheet-row" data-line={row.line}>
                    <td className="font-mono text-muted">{row.line}</td>
                    <td className="min-w-32">
                      {row.tie ? (
                        <>
                          <p className="font-bold">{row.tie.label}</p>
                          <p className="text-muted">{[row.tie.event, row.tie.court, row.tie.time].filter(Boolean).join(" · ")}{row.tie.locked ? " · locked" : ""}</p>
                          {row.swapped && <p className="text-muted">(nations the other way round in the sheet)</p>}
                          {row.notes.map((n) => <p key={n} className="text-warning">{n}</p>)}
                        </>
                      ) : (
                        <p className="font-semibold text-danger" data-testid="sheet-row-error">{row.error}</p>
                      )}
                    </td>
                    {CELL_ORDER.map((cell) => {
                      const m = row.cells[cell];
                      if (!tie || !m) return <td key={cell} />;
                      const side = cell.startsWith("A") ? "A" : "B";
                      const picked = cell in (choices[row.line] ?? {});
                      const chosen = picked ? (choices[row.line]![cell] ?? null) : m.id;
                      return (
                        <td key={cell}>
                          <select
                            className={`input border-2 px-1 py-1 text-xs ${tone(m, chosen, picked)}`}
                            value={chosen ?? ""}
                            onChange={(e) => choose(row.line, cell, e.target.value || null)}
                            data-testid="sheet-cell"
                            data-cell={cell}
                            data-status={picked ? "picked" : m.status}
                            title={m.raw ? `Typed: ${m.raw}` : undefined}
                          >
                            <option value="">{m.raw && !picked && m.status === "unknown" ? `✗ ${m.raw}` : "—"}</option>
                            {tie.sides[side].squad.map((p, i) => (
                              <option key={p.id} value={p.id}>No. {i + 1} · {p.name}</option>
                            ))}
                          </select>
                          {!picked && m.status === "close" && <p className="mt-0.5 text-warning">“{m.raw}”: did you mean {m.suggestions.map((s) => s.name).join(" or ")}?</p>}
                          {!picked && m.status === "unknown" && <p className="mt-0.5 font-semibold text-danger">“{m.raw}” is not in the squad</p>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(rowErrors.length > 0 || problems.length > 0) && (
            <ul className="space-y-1 text-xs font-semibold text-danger" data-testid="sheet-problems">
              {rowErrors.map(({ row }) => <li key={`e${row.line}`}>Row {row.line}: {row.error} (this row is left out)</li>)}
              {problems.map((p) => (
                <li key={`${p.line}-${p.side}-${p.issue.key}`}>Row {p.line}, nation {p.side}: <IssueText issue={p.issue} /></li>
              ))}
            </ul>
          )}

          {warnings.length > 0 && (
            <div className="space-y-2" data-testid="sheet-warnings">
              {warnings.map((w) => (
                <div key={`${w.line}-${w.issue.key}`} className="rounded-xl border-2 border-warning bg-warning/10 p-2 text-xs" data-testid="lineup-warning" data-code={w.issue.code}>
                  <p className="font-semibold">⚠ Row {w.line} ({w.nation}): <IssueText issue={w.issue} /></p>
                  <label className="mt-1 flex items-center gap-1.5 font-semibold">
                    <input
                      type="checkbox"
                      checked={accepted.has(w.issue.key)}
                      onChange={(e) => setAccepted((a) => { const n = new Set(a); if (e.target.checked) n.add(w.issue.key); else n.delete(w.issue.key); return n; })}
                      data-testid="accept-warning"
                    />
                    Accept the exception (recorded; the master referees are told)
                  </label>
                </div>
              ))}
            </div>
          )}

          {late && (
            <label className="block text-xs">
              <span className="label">Reason for changes to locked line-ups (recorded as late changes, <RegLink reg="46" />)</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="sheet-reason" />
            </label>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary" disabled={!canConfirm} onClick={() => void confirm()} data-testid="sheet-confirm">
              {busy === "apply" ? "Saving…" : `Confirm ${changes.length} tie${changes.length === 1 ? "" : "s"}`}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setRows(null)}>Cancel</button>
            <p className="text-xs text-muted">{changes.length === 0 ? "Nothing in the sheet changes a line-up." : "Rows that change nothing are skipped."}</p>
          </div>
        </div>
      )}
      {error && <p className="text-xs font-semibold text-danger" role="alert" data-testid="sheet-error">{error}</p>}
      {done && <p className="text-xs font-semibold text-success" role="status" data-testid="sheet-done">{done}</p>}
    </section>
  );
}

