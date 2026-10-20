"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { checkCoachLineup, clockIn, sameLineup } from "@/lib/coaches/lineupEntry";
import { doublesOf, type LineupDraft, type LineupIssue } from "@/lib/tennis/lineupRules";
import type { MCoachLineupEntry } from "@/lib/mobile/contract";
import { IssueText, RegLink } from "@/components/lineups/RegLink";

type Slot = "S1" | "S2" | "D1" | "D2";
const SLOT_LABEL: Record<Slot, string> = { S1: "Singles 1", S2: "Singles 2", D1: "Doubles", D2: "Doubles" };

const copy = (l: LineupDraft): LineupDraft => ({ S1: l.S1, S2: l.S2, D: [l.D[0] ?? null, l.D[1] ?? null] });
const get = (d: LineupDraft, s: Slot) => (s === "D1" ? (d.D[0] ?? null) : s === "D2" ? (d.D[1] ?? null) : d[s]);
function put(d: LineupDraft, s: Slot, id: string | null): LineupDraft {
  const n = copy(d);
  if (s === "D1") n.D[0] = id;
  else if (s === "D2") n.D[1] = id;
  else n[s] = id;
  return n;
}
const start = (e: MCoachLineupEntry) => copy(e.submitted?.lineup ?? e.official);

/**
 * The coach's own line-up form (web; the app has its own): their team's singles players
 * from the squad (order of merit) and, if they wish, the doubles pair. Same checks as the
 * officials' picker; a warning (Reg 43 order of merit, Reg 50) is submitted only once the
 * coach accepts it, and the master referees and the organiser are told. The officials
 * confirm the submission, which locks it. Server: /api/mobile/v1/coach/ties/[id]/lineup.
 */
export default function CoachLineupForm({ tieId, initial, timeZone }: { tieId: string; initial: MCoachLineupEntry; timeZone: string }) {
  const router = useRouter();
  const [entry, setEntry] = useState(initial);
  const [draft, setDraft] = useState<LineupDraft>(start(initial));
  const [accepted, setAccepted] = useState<Set<string>>(new Set(initial.submitted?.accepted ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const check = useMemo(() => checkCoachLineup(draft, entry.squad, { retired: entry.retired, open: entry.openRubbers as LineupIssue["rubbers"] }), [draft, entry]);
  const pending = check.warnings.filter((w) => !accepted.has(w.key));
  const unchanged = entry.submitted ? sameLineup(entry.submitted.lineup, draft) && pending.length === 0 : false;
  const canSave = entry.open && !busy && check.problems.length === 0 && pending.length === 0 && !unchanged;
  const name = (id: string | null | undefined) => (id ? (entry.squad.find((p) => p.id === id)?.name ?? "?") : "—");
  const editable = (type: string) => entry.rubbers.find((r) => r.type === type)?.editable ?? false;

  const save = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/mobile/v1/coach/ties/${tieId}/lineup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineup: draft, accept: [...accepted] }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; entry?: MCoachLineupEntry; exceptionAlerted?: number; accepted?: unknown[] };
      if (!res.ok || !body.entry) {
        setError(body.error ?? "Not submitted. Try again.");
        return;
      }
      setEntry(body.entry);
      setDraft(start(body.entry));
      setDone(`Line-up submitted. The court referee and the master referees confirm it.${body.accepted?.length ? " The exception you accepted has been passed on to the master referees and the organiser." : ""}`);
      router.refresh();
    } catch {
      setError("No connection: nothing was submitted. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const select = (slot: Slot) => {
    const type = slot === "D1" || slot === "D2" ? "D" : slot;
    return (
      <label key={slot} className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-muted">{SLOT_LABEL[slot]}</span>
        <select
          className="input py-3 text-base"
          value={get(draft, slot) ?? ""}
          disabled={!entry.open || !editable(type) || busy}
          onChange={(e) => setDraft((d) => put(d, slot, e.target.value || null))}
          data-testid={`coach-pick-${slot}`}
          aria-label={SLOT_LABEL[slot]}
        >
          <option value="">{type === "D" ? "To be named" : "Choose…"}</option>
          {entry.squad.map((p, i) => (
            <option key={p.id} value={p.id}>
              No. {i + 1} · {p.name}
              {entry.retired.includes(p.id) ? " (retired earlier)" : ""}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const d = doublesOf(entry.official);
  return (
    <section className="card space-y-4 p-5" data-testid="coach-lineup-form" data-open={entry.open ? "1" : "0"}>
      <div className="space-y-1">
        <h2 className="text-xl font-bold">{entry.open ? (entry.submitted ? "Change your line-up" : "Enter your line-up") : "Your line-up"}</h2>
        {entry.open ? (
          <p className="text-sm text-muted">
            Pick your two singles players from your squad (in order of merit, No. 1 first): the higher-ranked plays Singles 1 (<RegLink reg="43" />). The doubles pair can stay to be named until after the singles.
            {entry.deadline ? ` Open until ${clockIn(entry.deadline, timeZone)}.` : " Open until the referee confirms the line-ups."} The opponents never see it before then.
          </p>
        ) : (
          <p className="text-sm font-semibold" data-testid="coach-lineup-closed">{entry.closedMessage}</p>
        )}
        {entry.submitted && (
          <p className="text-sm" data-testid="coach-lineup-submitted">
            You submitted at {clockIn(entry.submitted.at, timeZone)}: S1 {name(entry.submitted.lineup.S1)} · S2 {name(entry.submitted.lineup.S2)} · D {doublesOf(entry.submitted.lineup)?.map(name).join(" / ") ?? "to be named"}.
          </p>
        )}
        <p className="text-xs text-muted">
          As the referee holds it now: S1 {name(entry.official.S1)} · S2 {name(entry.official.S2)} · D {d ? d.map(name).join(" / ") : "to be named"}.
        </p>
      </div>

      {entry.open && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">{(["S1", "S2", "D1", "D2"] as Slot[]).map(select)}</div>
          {check.problems.length > 0 && (
            <ul className="space-y-1 text-sm font-semibold text-danger" role="alert" data-testid="coach-lineup-problems">
              {check.problems.map((p) => (
                <li key={p.key}>
                  <IssueText issue={p} />
                </li>
              ))}
            </ul>
          )}
          {check.warnings.map((w) => (
            <div key={w.key} className="rounded-2xl border-2 border-warning bg-warning/10 p-3" data-testid="coach-lineup-warning" data-code={w.code}>
              <p className="text-sm font-bold">
                ⚠ <IssueText issue={w} />
              </p>
              <label className="mt-2 flex min-h-11 items-center gap-2 text-sm font-semibold">
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
                  data-testid="coach-accept-warning"
                />
                I accept this exception (the master referees and the organiser are told)
              </label>
            </div>
          ))}
          <button type="button" className="btn-primary px-6 py-3 text-base" disabled={!canSave} onClick={() => void save()} data-testid="coach-submit-lineup">
            {busy ? "Submitting…" : entry.submitted ? "Submit the change" : "Submit the line-up"}
          </button>
        </>
      )}
      {error && <p className="text-sm font-semibold text-danger" role="alert">{error}</p>}
      {done && <p className="text-sm font-semibold text-success" role="status">{done}</p>}
    </section>
  );
}
