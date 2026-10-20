import { durationText, statLines, type MatchStatsResult } from "@/lib/scoring/stats";

/**
 * The public match page's Stats card: two-column bars (side A grows left from the
 * middle, side B right), from scoring/stats.ts. Server component; nothing to hydrate.
 */
export default function MatchStatsCard({ stats, aName, bName }: { stats: MatchStatsResult; aName: string; bName: string }) {
  if (!stats.available) {
    if (stats.reason === "no_points") return null;
    return (
      <section className="card" data-testid="match-stats">
        <h2 className="label">Stats</h2>
        <p className="text-sm text-muted">{stats.note}</p>
      </section>
    );
  }
  const lines = statLines(stats.sides);
  return (
    <section className="card space-y-3" data-testid="match-stats" aria-label="Match stats">
      <div className="flex items-center justify-between gap-3">
        <h2 className="label mb-0">Stats</h2>
        <span className="text-xs text-muted tabular-nums">
          Match time {durationText(stats.durationSeconds)}
          {stats.sets.length > 1 ? ` · ${stats.sets.map((s) => `${s.label} ${durationText(s.seconds)}`).join(" · ")}` : ""}
        </span>
      </div>
      <div className="flex justify-between text-sm font-semibold">
        <span className="truncate">{aName}</span>
        <span className="truncate text-right">{bName}</span>
      </div>
      <ul className="space-y-3">
        {lines.map((l) => (
          <li key={l.key} aria-label={`${l.label}: ${aName} ${l.a}, ${bName} ${l.b}`}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm tabular-nums">
              <span className={l.lead === "A" ? "font-semibold" : "text-muted"}>{l.a}</span>
              <span className="text-xs text-muted">{l.label}</span>
              <span className={l.lead === "B" ? "font-semibold" : "text-muted"}>{l.b}</span>
            </div>
            <div className="grid grid-cols-2 gap-1" aria-hidden>
              <div className="flex h-1.5 justify-end overflow-hidden rounded-full bg-border">
                <div className={`h-full rounded-full ${l.lead === "A" ? "bg-accent" : "bg-muted"}`} style={{ width: `${Math.round(l.aBar * 100)}%` }} />
              </div>
              <div className="flex h-1.5 overflow-hidden rounded-full bg-border">
                <div className={`h-full rounded-full ${l.lead === "B" ? "bg-accent" : "bg-muted"}`} style={{ width: `${Math.round(l.bBar * 100)}%` }} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
