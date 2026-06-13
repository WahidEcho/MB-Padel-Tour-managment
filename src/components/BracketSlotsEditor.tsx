"use client";

import { useState } from "react";
import type { BracketSlot, Team } from "@/lib/types";

export default function BracketSlotsEditor({
  slots,
  teams,
}: {
  slots: BracketSlot[];
  teams: Team[];
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(slots.map((s) => [s.id, s.is_bye ? "__bye__" : (s.team_id ?? "")]))
  );

  function handleChange(slotId: string, newValue: string) {
    setValues((prev) => {
      const next = { ...prev };
      // If newValue is already used by another slot, swap the two slots
      if (newValue && newValue !== "__bye__") {
        const conflictId = Object.entries(next).find(
          ([id, v]) => id !== slotId && v === newValue
        )?.[0];
        if (conflictId) next[conflictId] = next[slotId];
      }
      next[slotId] = newValue;
      return next;
    });
  }

  const matchCount = Math.ceil(slots.length / 2);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: matchCount }, (_, mi) => (
        <div key={mi} className="rounded-xl border border-border bg-background p-2">
          <p className="mb-1 text-xs font-bold uppercase text-muted">Match {mi + 1}</p>
          {slots.slice(mi * 2, mi * 2 + 2).map((slot) => (
            <select
              key={slot.id}
              name={`slot_${slot.id}`}
              value={values[slot.id]}
              onChange={(e) => handleChange(slot.id, e.target.value)}
              className="input mb-1 text-xs"
            >
              <option value="">— empty —</option>
              <option value="__bye__">BYE (lucky team advances)</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.team_name}
                </option>
              ))}
            </select>
          ))}
        </div>
      ))}
    </div>
  );
}
