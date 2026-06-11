import { roundLabel } from "@/lib/bracket";
import type { BracketSlot, Match, Team } from "@/lib/types";

export function orderedRounds(slots: BracketSlot[]): string[] {
  const names = [...new Set(slots.map((s) => s.round_name))];
  const weight = (n: string) =>
    n === "TP" ? 0 : n === "F" ? 1 : n === "SF" ? 2 : n === "QF" ? 3 : parseInt(n.slice(1), 10) || 99;
  return names.sort((a, b) => weight(b) - weight(a));
}

export default function BracketView({
  slots,
  teams,
  matches,
  big = false,
}: {
  slots: BracketSlot[];
  teams: Map<string, Team>;
  matches: Map<string, Match>;
  big?: boolean;
}) {
  const rounds = orderedRounds(slots);
  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {rounds.map((roundName) => {
        const roundSlots = slots
          .filter((s) => s.round_name === roundName)
          .sort((a, b) => a.slot_order - b.slot_order);
        const pairs: BracketSlot[][] = [];
        for (let i = 0; i < roundSlots.length; i += 2) pairs.push(roundSlots.slice(i, i + 2));
        return (
          <div key={roundName} className="flex min-w-44 flex-col">
            <h4 className={`mb-2 text-center font-bold uppercase tracking-wide text-muted ${big ? "text-lg" : "text-xs"}`}>
              {roundLabel(roundName)}
            </h4>
            <div className="flex flex-1 flex-col justify-around gap-3">
              {pairs.map((pair, pi) => {
                const match = pair[0]?.match_id ? matches.get(pair[0].match_id) : null;
                return (
                  <div key={pi} className={`card space-y-1 p-2 ${big ? "p-3" : ""}`}>
                    {pair.map((slot) => {
                      const team = slot.team_id ? teams.get(slot.team_id) : null;
                      const isWinner = match?.winner_team_id && match.winner_team_id === slot.team_id;
                      return (
                        <div
                          key={slot.id}
                          className={`flex items-center justify-between rounded-lg px-2 py-1 ${
                            isWinner ? "bg-success/15 font-bold text-success" : "bg-background"
                          } ${big ? "text-xl" : "text-sm"}`}
                        >
                          <span className="truncate">
                            {slot.is_bye ? "— BYE —" : team?.team_name ?? "TBD"}
                          </span>
                          {isWinner && <span>✓</span>}
                        </div>
                      );
                    })}
                    {match && (
                      <p className={`text-center text-muted ${big ? "text-sm" : "text-[10px]"}`}>
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
