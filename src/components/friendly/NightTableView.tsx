import type { ReactNode } from "react";
import type { NightEntryState, NightTable, NightTableEntry } from "@/lib/friendly/nightTable";

/**
 * A night's table on the web: the public session page, the organiser's session
 * page and the TV draw this one component from `buildNightTable()`
 * (src/lib/friendly/nightTable.ts). The layout follows `table.layout`, so the
 * owner's reference layout lands here (and in the app's NightTable) without
 * touching how the table is stored or estimated.
 *
 * Presentational only (no hooks): usable from server pages and client scenes.
 */

const STATE_CLASS: Record<NightEntryState, string> = {
  waiting: "border-border",
  called: "border-warning/60",
  live: "border-success/60 bg-success/5",
  finished: "border-border opacity-70",
  cancelled: "border-border opacity-50 line-through",
};

const BADGE: Partial<Record<NightEntryState, { text: string; className: string }>> = {
  called: { text: "Called", className: "bg-warning/15 text-warning" },
  live: { text: "Live", className: "bg-success/15 text-success" },
};

function Entry({ e, tv, court, action }: { e: NightTableEntry; tv: boolean; court?: string; action?: ReactNode }) {
  const badge = BADGE[e.state];
  return (
    <li
      data-testid="night-entry"
      data-state={e.state}
      className={`rounded-xl border ${STATE_CLASS[e.state]} ${tv ? "px-5 py-3" : "px-2 py-1.5"}`}
    >
      <div className={`flex items-baseline justify-between gap-2 ${tv ? "text-[26px]" : "text-xs"} text-muted`}>
        <span>
          {court ? `${court} · ` : ""}
          {e.position}. {e.round ?? ""}
        </span>
        <span className={`font-semibold ${e.state === "waiting" || e.state === "called" ? "text-accent" : ""}`} data-testid="night-label">
          {badge && <span className={`badge mr-1 ${badge.className}`}>{badge.text}</span>}
          {e.label}
        </span>
      </div>
      <p className={`truncate font-semibold ${tv ? "text-[34px] leading-tight" : "text-sm"} ${e.winner === "A" ? "text-success" : ""}`}>{e.a}</p>
      <p className={`truncate ${tv ? "text-[28px]" : "text-xs"} ${e.winner === "B" ? "font-semibold text-success" : "text-muted"}`}>v {e.b}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </li>
  );
}

export default function NightTableView({
  table,
  variant = "page",
  actions,
  limitPerCourt,
}: {
  table: NightTable;
  variant?: "page" | "tv";
  /** Per match id: a control under the entry (the organiser's result entry). */
  actions?: Map<string, ReactNode>;
  /** The TV shows what is coming: this many entries per court from the first not finished. */
  limitPerCourt?: number;
}) {
  const tv = variant === "tv";
  if (table.layout === "by_round") {
    return (
      <div className={tv ? "grid h-full gap-5 overflow-hidden px-5 pb-5" : "space-y-3"} data-testid="night-table" data-layout="by_round">
        {table.rounds.map((r) => (
          <section key={r.round}>
            <p className={`mb-1 font-bold uppercase text-muted ${tv ? "text-[28px]" : "text-xs"}`}>{r.round}</p>
            <ul className={`grid gap-2 ${tv ? "grid-cols-3" : "sm:grid-cols-2"}`}>
              {r.entries.map((e) => (
                <Entry key={e.matchId} e={e} tv={tv} court={e.court} action={actions?.get(e.matchId)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }
  const courts = table.courts.map((c) => {
    if (!limitPerCourt) return c;
    const from = Math.max(0, c.entries.findIndex((e) => e.state !== "finished" && e.state !== "cancelled"));
    const first = c.entries.every((e) => e.state === "finished" || e.state === "cancelled") ? Math.max(0, c.entries.length - 1) : from;
    return { ...c, entries: c.entries.slice(first, first + limitPerCourt) };
  });
  return (
    <div
      data-testid="night-table"
      data-layout="by_court"
      className={tv ? "grid h-full gap-5 overflow-hidden px-5 pb-5" : "grid gap-3 sm:grid-cols-2"}
      style={tv ? { gridTemplateColumns: `repeat(${Math.max(1, Math.min(4, courts.length))}, minmax(0, 1fr))` } : undefined}
    >
      {courts.map((c) => (
        <section key={c.courtId || "none"} className="min-w-0" data-testid="night-court">
          <p className={`mb-1 font-bold uppercase text-muted ${tv ? "text-[30px]" : "text-xs"}`}>{c.name}</p>
          <ol className={tv ? "space-y-3" : "space-y-1.5"}>
            {c.entries.map((e) => (
              <Entry key={e.matchId} e={e} tv={tv} action={actions?.get(e.matchId)} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
