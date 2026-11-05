import { placementBrackets, type BracketSide, type BracketTie } from "@/lib/tennis/bracketView";
import { toTie } from "@/lib/mobile/projection";
import type { Team, Tie } from "@/lib/types";

/**
 * The placement draws of a nations event (Cup = places 1–8, Plate = 9–16) as
 * brackets on the public website: one column per round, each split into its
 * blocks, a "Winner QF 1" line while a nation is not known yet. Laid out by
 * `placementBrackets`, the same model as the app's Brackets tab.
 */
export default function TieBrackets({
  ties,
  teams,
  courts,
  timeZone,
}: {
  ties: Tie[];
  teams: Map<string, Team>;
  courts: Map<string, string>;
  timeZone: string;
}) {
  const draws = placementBrackets(ties.map(toTie));
  if (!draws.length) {
    return <p className="card p-8 text-center text-muted">The play-off draws appear here once the group stage is over.</p>;
  }
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <div className="space-y-8">
      {draws.map((draw) => (
        <section key={draw.key} className="space-y-2" data-testid={`tie-bracket-${draw.name}`}>
          <div className="flex items-baseline gap-2">
            <h3 className="text-lg font-bold">{draw.name}</h3>
            {draw.places && <span className="text-sm text-muted">{draw.places}</span>}
          </div>
          <div className="overflow-x-auto pb-2">
            <div className="flex min-w-max gap-4">
              {draw.rounds.map((round) => (
                <div key={round.roundNo} className="w-64 space-y-4">
                  {round.blocks.map((block) => (
                    <div key={block.name} className="space-y-2">
                      <h4 className="label">{block.name}</h4>
                      {block.ties.map((bt) => (
                        <TieBox key={bt.tie.id} bt={bt} teams={teams} court={bt.tie.courtId ? courts.get(bt.tie.courtId) : undefined} when={when(bt.tie.scheduledTime)} />
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function TieBox({ bt, teams, court, when }: { bt: BracketTie; teams: Map<string, Team>; court: string | undefined; when: string | null }) {
  const { tie } = bt;
  const done = tie.status === "completed";
  return (
    <article className="card space-y-1 p-3" data-testid="bracket-tie">
      <p className="flex items-center justify-between text-xs font-bold text-muted">
        <span>{bt.ref}</span>
        {tie.status === "live" && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white">LIVE</span>}
      </p>
      <Side side={bt.a} team={bt.a.teamId ? teams.get(bt.a.teamId) : undefined} score={tie.a ? tie.rubbersA : null} won={done && tie.winner !== null && tie.winner === tie.a} started={tie.status !== "scheduled"} />
      <Side side={bt.b} team={bt.b.teamId ? teams.get(bt.b.teamId) : undefined} score={tie.b ? tie.rubbersB : null} won={done && tie.winner !== null && tie.winner === tie.b} started={tie.status !== "scheduled"} />
      {(when || court) && <p className="pt-1 text-[11px] uppercase tracking-wide text-muted">{[when, court].filter(Boolean).join(" · ")}</p>}
    </article>
  );
}

function Side({ side, team, score, won, started }: { side: BracketSide; team: Team | undefined; score: number | null; won: boolean; started: boolean }) {
  const flag = team?.iso2 && /^[a-z]{2}$/.test(team.iso2) ? `/flags/${team.iso2}.svg` : null;
  return (
    <div className="flex items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {flag ? <img src={flag} alt="" className="h-4 w-6 rounded-sm object-cover shadow" /> : <span className="h-4 w-6" />}
      <span className={`min-w-0 flex-1 truncate ${team ? (won ? "font-bold" : "") : "italic text-muted"}`}>{team?.team_name ?? side.from ?? "To be decided"}</span>
      {started && score !== null && <span className={`tabular-nums ${won ? "font-bold" : "text-muted"}`}>{score}</span>}
    </div>
  );
}
