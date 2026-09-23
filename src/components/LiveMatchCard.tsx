import Avatar from "./Avatar";
import MatchStatusBadge from "./MatchStatusBadge";
import type { Match, MatchSnapshot, Team } from "@/lib/types";
import { formatSet } from "@/lib/scoring/engine";

function setScores(snap: MatchSnapshot | null): string {
  if (!snap) return "";
  const sets = Array.isArray(snap.completed_sets) ? snap.completed_sets : [];
  return sets.map((s) => formatSet(s, { tiebreakSpace: true })).join("  ");
}

export default function LiveMatchCard({
  match,
  snapshot,
  teamA,
  teamB,
  courtName,
  big = false,
}: {
  match: Match;
  snapshot: MatchSnapshot | null;
  teamA: Team | undefined;
  teamB: Team | undefined;
  courtName?: string;
  big?: boolean;
}) {
  const live = match.status === "live";
  const rows: { team: Team | undefined; points: string; games: number; sets: number; serving: boolean; winner: boolean }[] = [
    {
      team: teamA,
      points: snapshot ? (snapshot.is_tiebreak ? String(snapshot.tiebreak_team_a_points) : snapshot.team_a_point_label) : "0",
      games: snapshot?.team_a_games ?? 0,
      sets: snapshot?.team_a_sets ?? 0,
      serving: Boolean(snapshot?.serving_team_id && snapshot.serving_team_id === match.team_a_id),
      winner: Boolean(match.winner_team_id && match.winner_team_id === match.team_a_id),
    },
    {
      team: teamB,
      points: snapshot ? (snapshot.is_tiebreak ? String(snapshot.tiebreak_team_b_points) : snapshot.team_b_point_label) : "0",
      games: snapshot?.team_b_games ?? 0,
      sets: snapshot?.team_b_sets ?? 0,
      serving: Boolean(snapshot?.serving_team_id && snapshot.serving_team_id === match.team_b_id),
      winner: Boolean(match.winner_team_id && match.winner_team_id === match.team_b_id),
    },
  ];

  return (
    <div className={`card space-y-2 ${live ? "border-accent/60" : ""}`}>
      <div className="flex items-center justify-between text-muted">
        <span className={big ? "text-lg font-bold" : "text-xs font-semibold"}>
          {courtName ? `${courtName} · ` : ""}{match.round_name}
        </span>
        <MatchStatusBadge status={match.status} />
      </div>
      {rows.map((r, i) => (
        <div
          key={i}
          className={`flex items-center justify-between gap-2 rounded-xl px-2 py-1.5 ${
            r.winner ? "bg-success/10" : "bg-background"
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex shrink-0 -space-x-1.5">
              {r.team?.players?.map((p) => (
                <Avatar key={p.id} name={p.full_name} person={p} size={big ? 40 : 26} eager={big} />
              ))}
            </div>
            <div className="min-w-0">
              <p className={`truncate font-bold ${big ? "text-3xl" : "text-sm"}`}>
                {r.serving && <span className="mr-1">🎾</span>}
                {r.team?.team_name ?? "TBD"}
                {r.winner && " 🏆"}
              </p>
              {big && (
                <p className="truncate text-sm text-muted">{r.team?.players?.map((p) => p.full_name).join(" & ")}</p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 tabular-nums">
            <span className={`text-muted ${big ? "text-2xl" : "text-xs"}`} title="Sets">{r.sets}</span>
            <span className={`font-semibold ${big ? "text-4xl" : "text-base"}`} title="Games">{r.games}</span>
            <span className={`w-12 text-center font-bold text-accent ${big ? "text-6xl w-28" : "text-xl"}`}>
              {match.status === "live" || match.status === "paused" ? r.points : ""}
            </span>
          </div>
        </div>
      ))}
      {snapshot && setScores(snapshot) && (
        <p className={`text-center text-muted ${big ? "text-lg" : "text-xs"}`}>Sets: {setScores(snapshot)}</p>
      )}
      {snapshot?.is_tiebreak && live && (
        <p className={`text-center font-bold uppercase tracking-widest text-accent ${big ? "text-lg" : "text-[10px]"}`}>
          Tie-break
        </p>
      )}
    </div>
  );
}
