"use client";

import { useState, type ReactNode } from "react";

/**
 * A day picker over server-rendered panels (the public order of play): every
 * day is in the cached page, the picker only shows one, so the page stays one
 * shared copy for every visitor.
 */
export default function DayTabs({ days, initial, panels }: { days: { key: string; label: string; today?: boolean }[]; initial: string; panels: Record<string, ReactNode> }) {
  const [day, setDay] = useState(initial);
  const shown = panels[day] ? day : initial;
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Day" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {days.map((d) => {
          const on = d.key === shown;
          return (
            <button
              key={d.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setDay(d.key)}
              className={`shrink-0 rounded-xl border px-3 py-1.5 text-sm font-semibold ${on ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted hover:text-foreground"}`}
              data-testid={`day-${d.key}`}
            >
              {d.today ? `Today · ${d.label}` : d.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{panels[shown]}</div>
    </div>
  );
}
