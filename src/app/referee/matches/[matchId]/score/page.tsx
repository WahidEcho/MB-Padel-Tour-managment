import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { getCourts, getMatch, getReopenState, getSnapshot, getTeams, getTournament, tierForMatch } from "@/lib/data";
import type { ScoreState } from "@/lib/scoring/engine";
import { isDoublesMatch, scoringConfigForMatch } from "@/lib/scoring/rules";
import ScoreClient from "./ScoreClient";
import ChessScoreClient from "./ChessScoreClient";
import { redBlueTeams } from "@/lib/sides";

export const dynamic = "force-dynamic";

export default async function ScorePage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  await requireRole(["referee", "admin", "manager"], `/referee/matches/${matchId}/score`);

  const match = await getMatch(matchId);
  if (!match || !match.team_a_id || !match.team_b_id) notFound();
  const [tournament, teams, courts, snapshot, tier, reopenState] = await Promise.all([
    getTournament(match.tournament_id),
    getTeams(match.tournament_id),
    getCourts(match.tournament_id),
    getSnapshot(matchId),
    tierForMatch(match),
    match.status === "completed" ? getReopenState(matchId) : Promise.resolve(null),
  ]);
  if (!tournament) notFound();

  const nationA = teams.find((t) => t.id === match.team_a_id)!;
  const nationB = teams.find((t) => t.id === match.team_b_id)!;
  const court = courts.find((c) => c.id === match.court_id);

  // A rubber of a tie is played by the captains' nominees, not the whole squad.
  const nominees = (team: typeof nationA, ids: string[] | null | undefined) =>
    ids?.length ? { ...team, players: ids.map((id) => team.players?.find((p) => p.id === id)).filter((p) => p !== undefined) } : null;
  const teamA = match.tie_id ? nominees(nationA, match.team_a_player_ids) : nationA;
  const teamB = match.tie_id ? nominees(nationB, match.team_b_player_ids) : nationB;
  // In a rubber the players are the side: "Popa (ROU)", "Grant / Pareja (USA)".
  const sideName = (t: typeof nationA) =>
    match.tie_id
      ? `${(t.players ?? []).map((p) => p.full_name.split(" ").slice(-1)[0]).join(" / ")} (${t.nation_code ?? t.team_name})`
      : t.team_name;
  if (!teamA || !teamB) {
    return (
      <div className="theme-dark mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
        <p className="text-xs text-muted">{tournament.name} · {court?.court_name ?? "No court"} · {match.round_name}</p>
        <h1 className="text-xl font-bold">Waiting for the line-ups</h1>
        <p className="text-sm text-muted">
          {!teamA ? nationA.team_name : nationB.team_name}&apos;s captain has not nominated the players for this rubber yet.
          The tournament desk enters them on the Ties page.
        </p>
        <a href={`/referee/tournaments/${match.tournament_id}/matches`} className="btn-secondary">← Matches</a>
      </div>
    );
  }

  if (tournament.sport === "chess") {
    return (
      <ChessScoreClient
        match={match}
        tournamentName={tournament.name}
        boardName={court?.court_name ?? "No board"}
        legs={tournament.format_config?.legs === 2 ? 2 : 1}
        teamA={{
          id: teamA.id,
          name: teamA.team_name,
          players: teamA.players?.map((p) => ({ name: p.full_name, photo: p })) ?? [],
        }}
        teamB={{
          id: teamB.id,
          name: teamB.team_name,
          players: teamB.players?.map((p) => ({ name: p.full_name, photo: p })) ?? [],
        }}
        serverSnapshot={snapshot}
      />
    );
  }

  return (
    <ScoreClient
      match={match}
      tournamentName={tournament.name}
      courtName={court?.court_name ?? "No court"}
      // The single place a match's rules are resolved. Stage overrides land here,
      // so the referee screen obeys them without any engine change: every engine
      // mutator already takes the config as its last argument.
      scoringConfig={scoringConfigForMatch(tournament, match, tier, {
        doubles: match.rubber_type ? match.rubber_type === "D" : isDoublesMatch(teamA, teamB),
      })}
      tennis={tournament.sport === "tennis"}
      teamA={{
        id: teamA.id,
        name: sideName(teamA),
        players: teamA.players?.map((p) => ({ name: p.full_name, photo: p })) ?? [],
        checkedIn: teamA.check_in_status === "checked_in",
        nation: match.tie_id ? (teamA.nation_code ?? null) : null,
      }}
      teamB={{
        id: teamB.id,
        name: sideName(teamB),
        players: teamB.players?.map((p) => ({ name: p.full_name, photo: p })) ?? [],
        checkedIn: teamB.check_in_status === "checked_in",
        nation: match.tie_id ? (teamB.nation_code ?? null) : null,
      }}
      serverSnapshot={snapshot}
      reopenState={reopenState as ScoreState | null}
      redBlueTeams={redBlueTeams(tournament.branding_config)}
    />
  );
}
