"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { changedRubbers, checkLineup, doublesOf, needsReason, warningsForChange, type LineupDraft, type LineupIssue } from "@/lib/tennis/lineupRules";
import type { LineupPicker as PickerModel, PickerSide } from "@/lib/tennis/lineupServer";
import { IssueText, RegLink } from "./RegLink";

type Side = "A" | "B";
type Slot = "S1" | "S2" | "D1" | "D2";

const SLOT_LABEL: Record<Slot, string> = { S1: "Singles 1", S2: "Singles 2", D1: "Doubles", D2: "Doubles" };

const copy = (l: LineupDraft): LineupDraft => ({ S1: l.S1, S2: l.S2, D: [l.D[0] ?? null, l.D[1] ?? null] });

function get(d: LineupDraft, slot: Slot): string | null {
  return slot === "D1" ? (d.D[0] ?? null) : slot === "D2" ? (d.D[1] ?? null) : d[slot];
}
function set(d: LineupDraft, slot: Slot, id: string | null): LineupDraft {
  const n = copy(d);
  if (slot === "D1") n.D[0] = id;
  else if (slot === "D2") n.D[1] = id;
  else n[slot] = id;
  return n;
}

/**
 * The court referee's line-up screen (web console; the app has its own): before the
 * tie each nation's two singles players from the squad (in order of merit), after
 * the singles the doubles pair. No approval step. A breach of an ITF rule is a
 * warning with its regulation link; the referee may accept it, and the master
 * referees and the organiser are told at once. After the line-ups are locked a
 * change needs a reason (recorded). The organiser and the master referees use the
 * same screen. Server: /api/mobile/v1/referee/matches/[matchId]/lineup.
 */
export default function LineupPicker({ initial, compact = false }: { initial: PickerModel; compact?: boolean }) {
  const router = useRouter();
  const [picker, setPicker] = useState(initial);
  const [drafts, setDrafts] = useState<Record<Side, LineupDraft>>({ A: copy(initial.sides.A.lineup), B: copy(initial.sides.B.lineup) });
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [editAll, setEditAll] = useState(false);
  const [doublesNow, setDoublesNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const editable = (type: "S1" | "S2" | "D") => picker.rubbers.find((r) => r.type === type)?.editable ?? false;
  const showSingles = editAll || picker.step === "singles";
  const showDoubles = editAll || picker.step === "doubles" || (picker.step === "doubles_later" && doublesNow);

  const checks = useMemo(() => {
    const out = {} as Record<Side, { problems: LineupIssue[]; warnings: LineupIssue[]; changed: boolean; late: boolean }>;
    for (const s of ["A", "B"] as const) {
      const side = picker.sides[s];
      const c = checkLineup(drafts[s], side.squad, { retired: side.retired, open: side.open });
      const changed = changedRubbers(side.lineup, drafts[s]);
      out[s] = {
        problems: c.problems,
        warnings: warningsForChange(c, changed).map((w) => ({ ...w, key: `${s}:${w.key}` })),
        changed: changed.length > 0,
        late: needsReason(picker.tie.locked, side.lineup, drafts[s]),
      };
    }
    return out;
  }, [drafts, picker]);

  const anyChange = checks.A.changed || checks.B.changed;
  // Only a side being changed can be refused; the other is sent as it is (not at all).
  const problems = (["A", "B"] as const).flatMap((s) => (checks[s].changed ? checks[s].problems : []));
  const warnings = [...checks.A.warnings, ...checks.B.warnings];
  const pending = warnings.filter((w) => !accepted.has(w.key));
  const late = checks.A.late || checks.B.late;
  const canSave = anyChange && problems.length === 0 && pending.length === 0 && (!late || reason.trim().length > 0) && !busy;

  const save = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    const lineups: Partial<Record<Side, LineupDraft>> = {};
    for (const s of ["A", "B"] as const) if (checks[s].changed) lineups[s] = drafts[s];
    try {
      const res = await fetch(`/api/mobile/v1/referee/matches/${picker.matchId}/lineup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineups, accept: [...accepted], reason: reason.trim() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; picker?: PickerModel; accepted?: unknown[]; locked?: boolean };
      if (!res.ok || !body.picker) {
        setError(body.error ?? "Not saved. Try again.");
        return;
      }
      setPicker(body.picker);
      setDrafts({ A: copy(body.picker.sides.A.lineup), B: copy(body.picker.sides.B.lineup) });
      setAccepted(new Set());
      setReason("");
      setEditAll(false);
      setDoublesNow(false);
      setDone(
        `Line-ups saved${body.locked ? "; the singles are locked" : ""}.${body.accepted?.length ? " Exception accepted: the master referees and the organiser have been told." : ""}`,
      );
      router.refresh();
    } catch {
      setError("No connection: nothing was saved. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const select = (s: Side, slot: Slot, side: PickerSide) => {
    const type = slot === "D1" || slot === "D2" ? "D" : slot;
    const value = get(drafts[s], slot);
    return (
      <label key={slot} className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-muted">{SLOT_LABEL[slot]}</span>
        <select
          className="input py-3 text-base"
          value={value ?? ""}
          disabled={!editable(type) || busy}
          onChange={(e) => setDrafts((d) => ({ ...d, [s]: set(d[s], slot, e.target.value || null) }))}
          data-testid={`pick-${s}-${slot}`}
          aria-label={`${side.nation} ${SLOT_LABEL[slot]}`}
        >
          <option value="">{type === "D" ? "To be named" : "Choose…"}</option>
          {side.squad.map((p, i) => (
            <option key={p.id} value={p.id}>
              No. {i + 1} · {p.name}
              {side.retired.includes(p.id) ? " (retired earlier)" : ""}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const named = (s: Side) => {
    const side = picker.sides[s];
    const name = (id: string | null | undefined) => (id ? (side.squad.find((p) => p.id === id)?.name ?? "?") : "—");
    const d = doublesOf(side.lineup);
    return (
      <ul className="space-y-0.5 text-sm">
        <li><span className="text-muted">S1</span> {name(side.lineup.S1)}</li>
        <li><span className="text-muted">S2</span> {name(side.lineup.S2)}</li>
        <li><span className="text-muted">D</span> {d ? d.map(name).join(" / ") : "to be named"}</li>
      </ul>
    );
  };

  const stepTitle =
    editAll
      ? "Change the line-up"
      : picker.step === "singles"
        ? "Singles players for this tie"
        : picker.step === "doubles"
          ? "The doubles pairs"
          : picker.step === "doubles_later"
            ? "Singles named · doubles after the singles"
            : "Line-ups named";

  return (
    <section className={`card space-y-4 ${compact ? "" : "p-5"}`} data-testid="lineup-picker" data-step={picker.step}>
      <div className="space-y-1">
        <p className="text-xs text-muted">
          {picker.tie.tournamentName} · {picker.tie.court ?? "No court"} · {picker.tie.round ?? "Tie"}
          {picker.tie.locked ? " · singles locked" : ""}
        </p>
        <h2 className="text-xl font-bold">{stepTitle}</h2>
        {picker.step === "singles" && !editAll && (
          <p className="text-sm text-muted">
            Pick each nation&apos;s two singles players from its squad (in order of merit, No. 1 first). The higher-ranked plays Singles 1 (<RegLink reg="43" />).
          </p>
        )}
        {picker.step === "doubles" && !editAll && <p className="text-sm text-muted">The singles are over: pick each nation&apos;s doubles pair (<RegLink reg="43" />).</p>}
        {picker.step === "doubles_later" && !editAll && (
          <p className="text-sm text-muted">
            The captains name the doubles pair after the singles (<RegLink reg="43" />).{" "}
            {!doublesNow && editable("D") && (
              <button type="button" className="font-semibold underline" onClick={() => setDoublesNow(true)} data-testid="doubles-now">Name it now</button>
            )}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {(["A", "B"] as const).map((s) => {
          const side = picker.sides[s];
          return (
            <div key={s} className="space-y-2 rounded-2xl border border-border p-3" data-testid={`lineup-side-${s}`}>
              <p className="text-base font-bold">
                {side.code ? `${side.code} · ` : ""}
                {side.nation}
              </p>
              {showSingles || showDoubles ? (
                <div className="grid gap-2">
                  {showSingles && (["S1", "S2"] as Slot[]).map((slot) => select(s, slot, side))}
                  {showDoubles && (["D1", "D2"] as Slot[]).map((slot) => select(s, slot, side))}
                </div>
              ) : (
                named(s)
              )}
            </div>
          );
        })}
      </div>

      {problems.length > 0 && (
        <ul className="space-y-1 text-sm font-semibold text-danger" role="alert" data-testid="lineup-problems">
          {problems.map((p) => (
            <li key={`${p.key}-${p.message}`}>
              <IssueText issue={p} />
            </li>
          ))}
        </ul>
      )}

      {warnings.length > 0 && (
        <div className="space-y-2" data-testid="lineup-warnings">
          {warnings.map((w) => (
            <div key={w.key} className="rounded-2xl border-2 border-warning bg-warning/10 p-3" data-testid="lineup-warning" data-code={w.code}>
              <p className="text-sm font-bold">
                ⚠ <IssueText issue={w} />
              </p>
              <label className="mt-2 flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={accepted.has(w.key)}
                  onChange={(e) =>
                    setAccepted((a) => {
                      const n = new Set(a);
                      if (e.target.checked) n.add(w.key);
                      else n.delete(w.key);
                      return n;
                    })
                  }
                  data-testid="accept-warning"
                />
                Accept this exception (the master referees and the organiser are told, with your name)
              </label>
            </div>
          ))}
        </div>
      )}

      {late && (
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-muted">
            Reason for the change (the line-ups are locked; recorded as a late change, <RegLink reg="46" />)
          </span>
          <input className="input py-3 text-base" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. No. 2 player ill in the warm-up" data-testid="lineup-reason" />
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(showSingles || showDoubles) && (
          <button type="button" className="btn-primary px-6 py-3 text-base" disabled={!canSave} onClick={() => void save()} data-testid="save-lineup">
            {busy ? "Saving…" : picker.tie.locked ? "Save the change" : showSingles ? "Confirm the singles" : "Confirm the doubles"}
          </button>
        )}
        {!editAll && picker.step !== "singles" && picker.rubbers.some((r) => r.editable) && (
          <button type="button" className="btn-secondary" onClick={() => setEditAll(true)} data-testid="change-lineup">
            Change the line-up
          </button>
        )}
        {editAll && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setEditAll(false);
              setDrafts({ A: copy(picker.sides.A.lineup), B: copy(picker.sides.B.lineup) });
            }}
          >
            Cancel
          </button>
        )}
      </div>
      {error && <p className="text-sm font-semibold text-danger" role="alert">{error}</p>}
      {done && <p className="text-sm font-semibold text-success" role="status" data-testid="lineup-saved">{done}</p>}
    </section>
  );
}
