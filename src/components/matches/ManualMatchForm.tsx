"use client";

import { useMemo, useRef, useState } from "react";
import { manualMatchWarnings, type ExistingMatch } from "@/lib/matches/manualMatchWarnings";

interface Option {
  id: string;
  name: string;
}

/**
 * "Add a match" for the organiser's matches page and the master referee's desk.
 * Nothing is created on the first press: the desk sees the match it is about to
 * add and every warning (a pair that already meets, a nation or a court still
 * busy today, a match outside the draw), then confirms. Warnings never refuse.
 */
export default function ManualMatchForm({
  action,
  tournamentId,
  teams,
  groups,
  courts,
  existing,
  tieFormat,
  timeZone,
  labels = { a: "Side A…", b: "Side B…", noGroup: "No group (knockout / friendly)" },
}: {
  action: (formData: FormData) => void | Promise<void>;
  tournamentId: string;
  teams: Option[];
  groups: Option[];
  courts: Option[];
  existing: ExistingMatch[];
  tieFormat: boolean;
  timeZone: string;
  labels?: { a: string; b: string; noGroup: string };
}) {
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<{ teamA: string; teamB: string; groupId: string; courtId: string; round: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const name = useMemo(() => new Map([...teams, ...courts, ...groups].map((o) => [o.id, o.name])), [teams, courts, groups]);

  const review = () => {
    const f = new FormData(form.current!);
    const teamA = String(f.get("team_a_id") ?? "");
    const teamB = String(f.get("team_b_id") ?? "");
    if (!teamA || !teamB) return setProblem("Pick both sides.");
    if (teamA === teamB) return setProblem("Pick two different sides.");
    setProblem(null);
    setDraft({ teamA, teamB, groupId: String(f.get("group_id") ?? ""), courtId: String(f.get("court_id") ?? ""), round: String(f.get("round_name") ?? "").trim() });
  };

  const warnings = draft
    ? manualMatchWarnings({ teamA: draft.teamA, teamB: draft.teamB, courtId: draft.courtId || null, groupId: draft.groupId || null }, existing, {
        tieFormat,
        teamName: (id) => name.get(id) ?? "TBD",
        courtName: (id) => name.get(id) ?? "the court",
        timeZone,
      })
    : [];

  const select = (field: string, empty: string, options: Option[], required = false) => (
    <select name={field} required={required} className="input" disabled={Boolean(draft)} onChange={() => setProblem(null)}>
      <option value="">{empty}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  );

  return (
    <form ref={form} action={action} className="space-y-3" data-testid="manual-match-form" onSubmit={() => setDraft(null)}>
      <input type="hidden" name="tournament_id" value={tournamentId} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {select("team_a_id", labels.a, teams, true)}
        {select("team_b_id", labels.b, teams, true)}
        {select("group_id", labels.noGroup, groups)}
        <input name="round_name" className="input" placeholder="Round name" readOnly={Boolean(draft)} />
        {select("court_id", "Court…", courts)}
        {!draft && (
          <button type="button" className="btn-primary" onClick={review} data-testid="manual-match-review">
            Add match
          </button>
        )}
      </div>
      {/* Disabled selects are not posted: while confirming, the chosen values travel as hidden fields. */}
      {draft && (
        <>
          <input type="hidden" name="team_a_id" value={draft.teamA} />
          <input type="hidden" name="team_b_id" value={draft.teamB} />
          <input type="hidden" name="group_id" value={draft.groupId} />
          <input type="hidden" name="court_id" value={draft.courtId} />
        </>
      )}
      {problem && <p className="text-xs font-semibold text-danger" role="status">{problem}</p>}
      {draft && (
        <div className="space-y-2 rounded-xl border border-border p-3" data-testid="manual-match-confirm">
          <p className="text-sm font-bold">
            Create {name.get(draft.teamA)} v {name.get(draft.teamB)}?
          </p>
          <p className="text-xs text-muted">
            {[draft.round || "Manual match", draft.groupId ? name.get(draft.groupId) : "no group", draft.courtId ? name.get(draft.courtId) : "no court yet"].join(" · ")}
          </p>
          {warnings.length > 0 && (
            <ul className="space-y-1" data-testid="manual-match-warnings">
              {warnings.map((w) => (
                <li key={w.code + w.message} className="text-xs font-semibold text-danger">⚠ {w.message}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" data-testid="manual-match-create">
              {warnings.length ? "Create it anyway" : "Yes, create it"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>
              Back
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
