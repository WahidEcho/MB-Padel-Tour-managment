import { notFound } from "next/navigation";
import { getCourts, getMatch, getSnapshot, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import Link from "next/link";
import AutoRefresh from "@/components/AutoRefresh";
import { hasPublicVenue } from "@/lib/venue/server";
import LiveMatchCard from "@/components/LiveMatchCard";
import YouTubeLivePlayer from "@/components/stream/YouTubeLivePlayer";
import { activeLiveVideos, liveVideoForMatch } from "@/lib/stream/liveVideo";
import ChessTheater from "@/components/ChessTheater";
import MatchStatsCard from "@/components/MatchStatsCard";
import { getMatchStats } from "@/lib/mobile/stats";
// ChessLiveCard is used elsewhere (live/overview/TV); the match page uses the theater view.
import {
  currentGame,
  formatMovePairs,
  inCheck as chessInCheck,
  matchScoreSummary,
  sideToMove,
  type ChessState,
} from "@/lib/chess/engine";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Rendered at most every 3s and shared by every visitor: at the venue a crowd
// refreshing this page reads one cached copy instead of the database each time.
export const revalidate = 3;

export function generateStaticParams() {
  return [];
}

export default async function PublicMatch({
  params,
}: {
  params: Promise<{ slug: string; matchId: string }>;
}) {
  const { slug, matchId } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament) notFound();
  const match = await getMatch(matchId);
  if (!match || match.tournament_id !== tournament.id) notFound();
  const [teams, snapshot, courts, venue, stats] = await Promise.all([
    getTeams(tournament.id),
    getSnapshot(matchId),
    getCourts(tournament.id),
    match.court_id ? hasPublicVenue(slug) : Promise.resolve(false),
    // Fans' stats (public tournaments only; aces only when the organiser shows them).
    getMatchStats(matchId).catch(() => null),
  ]);
  const tm = teamMap(teams);
  const courtName = new Map(courts.map((c) => [c.id, c.court_name]));
  // The court's live video, while this match is on it (Admin → Live stream).
  const video = liveVideoForMatch(match, activeLiveVideos(tournament.branding_config, courts.map((c) => ({ id: c.id, name: c.court_name, is_active: c.is_active }))));

  const teamA = match.team_a_id ? tm.get(match.team_a_id) : undefined;
  const teamB = match.team_b_id ? tm.get(match.team_b_id) : undefined;

  if (tournament.sport === "chess") {
    const state = (snapshot?.snapshot_json as ChessState | null) ?? null;
    const hasState = Boolean(state && state.games);
    const game = hasState ? currentGame(state!) : null;
    const whiteSide = game?.whiteSide ?? "A";
    const whiteName = (whiteSide === "A" ? teamA : teamB)?.team_name ?? "TBD";
    const blackName = (whiteSide === "A" ? teamB : teamA)?.team_name ?? "TBD";
    const toMoveSide =
      hasState && !state!.matchOver && game && !game.result ? sideToMove(state!) : null;
    const toMove = toMoveSide ? ((toMoveSide === "A") === (whiteSide === "A") ? "white" : "black") : null;
    const winnerColor =
      match.winner_team_id && hasState
        ? match.winner_team_id === (whiteSide === "A" ? teamA?.id : teamB?.id)
          ? "white"
          : "black"
        : null;
    const board = match.court_id ? courtName.get(match.court_id) : undefined;

    return (
      <div className="mx-auto max-w-3xl">
        <AutoRefresh seconds={4} />
        <ChessTheater
          fen={game?.fen ?? START_FEN}
          movePairs={game ? formatMovePairs(game.sanHistory) : []}
          whiteName={whiteName}
          blackName={blackName}
          toMove={toMove}
          inCheck={hasState ? chessInCheck(state!) : false}
          winnerColor={winnerColor}
          score={hasState ? matchScoreSummary(state!) : ""}
          heading={`${board ? `${board} · ` : ""}${match.round_name ?? ""}`}
          status={match.status}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <AutoRefresh seconds={4} />
      {video && <YouTubeLivePlayer key={video.youtubeId} video={video} />}
      <LiveMatchCard
        match={match}
        snapshot={snapshot}
        teamA={teamA}
        teamB={teamB}
        courtName={match.court_id ? courtName.get(match.court_id) : undefined}
        big
        liveVideo={Boolean(video)}
      />
      {stats && <MatchStatsCard stats={stats.stats} aName={teamA?.team_name ?? "TBD"} bName={teamB?.team_name ?? "TBD"} />}
      {venue && match.court_id && (
        <Link href={`/t/${slug}/map?court=${match.court_id}`} className="btn-secondary inline-flex text-sm" data-testid="show-on-map">
          Show on map
        </Link>
      )}
    </div>
  );
}
