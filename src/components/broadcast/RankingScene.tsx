import PersonPortrait from "./PersonPortrait";
import type { CeremonyPerson } from "@/lib/tv/ceremony";

export interface RankingRow {
  rank: number;
  person: CeremonyPerson;
  points: number;
  played: number;
  wins: number;
  gameDiff: number;
}

/**
 * A friendly session's standings on the wall.
 *
 * A session has no groups, so its leaderboard is the ranking itself. Two columns
 * of twelve fit the content row at a legible size; anyone below 24th is on the
 * public page, not the wall.
 */
export default function RankingScene({ title, rows }: { title: string; rows: RankingRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="flex h-full items-center justify-center text-[48px] text-muted" data-testid="ranking-empty">
        Standings appear after the first result.
      </p>
    );
  }
  const shown = rows.slice(0, 24);
  const columns = shown.length > 12 ? [shown.slice(0, 12), shown.slice(12)] : [shown];

  return (
    <div className="flex h-full flex-col gap-3 px-8 pb-4" data-testid="ranking-scene">
      <p className="text-[34px] font-bold uppercase tracking-[0.25em] text-muted">{title} · Standings</p>
      <div className="grid flex-1 gap-6" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((col, ci) => (
          <div key={ci} className="bc-card flex flex-col px-5 py-3">
            <div className="grid grid-cols-[70px_1fr_110px_90px_110px] items-center gap-3 pb-1 text-[22px] font-bold uppercase text-muted">
              <span>#</span>
              <span>Player</span>
              <span className="text-right">Pts</span>
              <span className="text-right">P</span>
              <span className="text-right">+/−</span>
            </div>
            {col.map((r) => (
              <div
                key={r.person.id}
                className="grid grid-cols-[70px_1fr_110px_90px_110px] items-center gap-3 border-t border-border/60 py-[5px]"
              >
                <span className="bc-num text-[34px] font-black text-accent">{r.rank}</span>
                <span className="flex min-w-0 items-center gap-3">
                  <PersonPortrait person={r.person} size={46} rounded="rounded-xl" />
                  <span className="truncate text-[32px] font-bold">{r.person.name}</span>
                </span>
                <span className="bc-num text-right text-[34px] font-black">{r.points}</span>
                <span className="bc-num text-right text-[28px] text-muted">{r.played}</span>
                <span className="bc-num text-right text-[28px] text-muted">{r.gameDiff > 0 ? `+${r.gameDiff}` : r.gameDiff}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
