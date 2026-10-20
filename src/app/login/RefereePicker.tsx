"use client";

import { useMemo, useState } from "react";
import { filterRefereeChoices, type RefereeChoice } from "@/lib/referees/rules";

/**
 * The PIN step's name picker (audit H1): the referee picks their own name (searchable,
 * with a photo when the organiser added one), then types their PIN, which the server
 * checks against that referee only. Plain radio inputs, so it works before the page's
 * script has loaded too.
 */
export default function RefereePicker({ referees, selected }: { referees: RefereeChoice[]; selected: string | null }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(selected && referees.some((r) => r.id === selected) ? selected : referees.length === 1 ? referees[0].id : null);
  // Back from a wrong PIN: the name picked before comes first, so it is in view and still chosen.
  const ordered = useMemo(() => (selected ? [...referees].sort((a, b) => Number(b.id === selected) - Number(a.id === selected)) : referees), [referees, selected]);
  const shown = useMemo(() => filterRefereeChoices(ordered, query), [ordered, query]);
  return (
    <div className="space-y-2" data-testid="referee-picker">
      <label className="label" htmlFor="referee-search">Your name</label>
      {referees.length > 6 && (
        <input
          id="referee-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your name"
          autoComplete="off"
          className="input"
          data-testid="referee-search"
        />
      )}
      <ul className="max-h-64 space-y-1 overflow-y-auto" role="radiogroup" aria-label="Your name">
        {shown.map((r) => (
          <li key={r.id}>
            <label
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm ${picked === r.id ? "border-accent bg-accent/10 font-semibold" : "border-border"}`}
              data-testid="referee-choice"
            >
              <input type="radio" name="referee_id" value={r.id} checked={picked === r.id} onChange={() => setPicked(r.id)} className="sr-only" required />
              {r.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.photoUrl} alt="" className="h-9 w-9 rounded-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/20 text-xs font-bold" aria-hidden>
                  {r.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
                </span>
              )}
              <span>{r.name}</span>
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="px-1 text-xs text-muted">No referee called that. Ask the desk to add you.</li>}
      </ul>
    </div>
  );
}
