import Avatar from "./Avatar";
import type { Match, Team } from "@/lib/types";

export interface PodiumResult {
  champion: Team | null;
  runnerUp: Team | null;
  third: Team | null;
}

export function podiumFromMatches(matches: Match[], teams: Map<string, Team>): PodiumResult {
  const finalMatch = matches.find((m) => m.stage === "final");
  const tpMatch = matches.find((m) => m.stage === "third_place");
  const champion = finalMatch?.winner_team_id ? teams.get(finalMatch.winner_team_id) ?? null : null;
  const runnerUp =
    finalMatch?.winner_team_id && finalMatch.team_a_id && finalMatch.team_b_id
      ? teams.get(finalMatch.winner_team_id === finalMatch.team_a_id ? finalMatch.team_b_id : finalMatch.team_a_id) ?? null
      : null;
  const third = tpMatch?.winner_team_id ? teams.get(tpMatch.winner_team_id) ?? null : null;
  return { champion, runnerUp, third };
}

function PodiumCard({
  team,
  emoji,
  label,
  big,
  highlight,
}: {
  team: Team | null;
  emoji: string;
  label: string;
  big: boolean;
  highlight?: boolean;
}) {
  if (!team) return null;
  return (
    <div className={`card flex flex-col items-center gap-2 text-center ${highlight ? "border-accent" : ""} ${big ? "p-8" : "p-5"}`}>
      <span className={big ? "text-6xl" : "text-4xl"}>{emoji}</span>
      <div className="flex -space-x-2">
        {team.players?.map((p) => (
          <Avatar key={p.id} name={p.full_name} photoUrl={p.photo_url} size={big ? 80 : 48} />
        ))}
      </div>
      <p className={`font-bold ${big ? "text-4xl" : "text-xl"}`}>{team.team_name}</p>
      <p className={`text-muted ${big ? "text-xl" : "text-sm"}`}>
        {team.players?.map((p) => p.full_name).join(" & ")}
      </p>
      <p className={`font-semibold uppercase tracking-widest text-accent ${big ? "text-lg" : "text-xs"}`}>{label}</p>
    </div>
  );
}

export default function WinnerDisplay({ podium, big = false }: { podium: PodiumResult; big?: boolean }) {
  if (!podium.champion && !podium.runnerUp && !podium.third) {
    return <p className="card p-10 text-center text-muted">The champion will be crowned here. Stay tuned! 🏆</p>;
  }
  return (
    <div className={`grid items-end gap-4 ${podium.third || podium.runnerUp ? "sm:grid-cols-3" : ""}`}>
      <PodiumCard team={podium.runnerUp} emoji="🥈" label="Runner-up" big={big} />
      <PodiumCard team={podium.champion} emoji="🏆" label="Champion" big={big} highlight />
      <PodiumCard team={podium.third} emoji="🥉" label="Third place" big={big} />
    </div>
  );
}
