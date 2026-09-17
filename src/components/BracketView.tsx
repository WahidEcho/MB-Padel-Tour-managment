import { roundLabel } from "@/lib/bracket";
import type { BracketSlot, Match, Team } from "@/lib/types";

export function orderedRounds(slots: BracketSlot[]): string[] {
  const names = [...new Set(slots.map((s) => s.round_name))];
  const weight = (n: string) =>
    n === "TP" ? 0 : n === "F" ? 1 : n === "SF" ? 2 : n === "QF" ? 3 : parseInt(n.slice(1), 10) || 99;
  return names.sort((a, b) => weight(b) - weight(a));
}

/**
 * A knockout tree.
 *
 * `big` is the admin and public pages' two-step sizing. `fontPx` is the venue
 * screen's: it hands in one number worked out from the room the tree has, and
 * every space inside is measured in it — see `bracketFontPx`.
 */
export default function BracketView({
  slots,
  teams,
  matches,
  big = false,
  fontPx,
}: {
  slots: BracketSlot[];
  teams: Map<string, Team>;
  matches: Map<string, Match>;
  big?: boolean;
  fontPx?: number;
}) {
  const rounds = orderedRounds(slots);
  const tv = typeof fontPx === "number";
  const px = (n: number) => (tv ? Math.round(fontPx! * n) : undefined);
  return (
    <div className={`flex gap-4 pb-2 ${tv ? "h-full overflow-hidden" : "overflow-x-auto"}`}>
      {rounds.map((roundName) => {
        const roundSlots = slots
          .filter((s) => s.round_name === roundName)
          .sort((a, b) => a.slot_order - b.slot_order);
        const pairs: BracketSlot[][] = [];
        for (let i = 0; i < roundSlots.length; i += 2) pairs.push(roundSlots.slice(i, i + 2));
        return (
          <div key={roundName} className={`flex flex-col ${tv ? "min-w-0 flex-1" : "min-w-44"}`}>
            <h4
              className={`mb-2 text-center font-bold uppercase tracking-wide text-muted ${tv ? "" : big ? "text-lg" : "text-xs"}`}
              style={tv ? { fontSize: px(0.8) } : undefined}
            >
              {roundLabel(roundName)}
            </h4>
            <div className="flex flex-1 flex-col justify-around gap-3">
              {pairs.map((pair, pi) => {
                const match = pair[0]?.match_id ? matches.get(pair[0].match_id) : null;
                return (
                  <div key={pi} className={`card space-y-1 ${tv ? "" : big ? "p-3" : "p-2"}`} style={tv ? { padding: px(0.35) } : undefined}>
                    {pair.map((slot) => {
                      const team = slot.team_id ? teams.get(slot.team_id) : null;
                      const isWinner = match?.winner_team_id && match.winner_team_id === slot.team_id;
                      return (
                        <div
                          key={slot.id}
                          className={`flex items-center justify-between rounded-lg px-2 py-1 ${
                            isWinner ? "bg-success/15 font-bold text-success" : "bg-background"
                          } ${tv ? "" : big ? "text-xl" : "text-sm"}`}
                          style={tv ? { fontSize: fontPx, padding: `${px(0.14)}px ${px(0.35)}px` } : undefined}
                        >
                          <span className="truncate">
                            {slot.is_bye ? "— BYE —" : team?.team_name ?? "TBD"}
                          </span>
                          {isWinner && <span>✓</span>}
                        </div>
                      );
                    })}
                    {match && (
                      <p
                        className={`text-center text-muted ${tv ? "" : big ? "text-sm" : "text-[10px]"}`}
                        style={tv ? { fontSize: px(0.62) } : undefined}
                      >
                        {match.round_name} · {match.status.replace("_", " ")}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
