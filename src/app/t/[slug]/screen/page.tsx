import { notFound } from "next/navigation";
import {
  getBracket,
  getBracketSlots,
  getCourts,
  getGroups,
  getMatches,
  getScreenSettings,
  getSnapshots,
  getStandings,
  getTeams,
  getTournamentBySlug,
  teamMap,
} from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import BracketView from "@/components/BracketView";
import LiveMatchCard from "@/components/LiveMatchCard";
import ChessLiveCard from "@/components/ChessLiveCard";
import LowerThird from "@/components/LowerThird";
import SponsorRotator from "@/components/SponsorRotator";
import StandingsTable from "@/components/StandingsTable";
import WinnerDisplay, { podiumFromMatches } from "@/components/WinnerDisplay";

export const dynamic = "force-dynamic";

export default async function TvScreen({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ court?: string; mode?: string }>;
}) {
  const { slug } = await params;
  const overrides = await searchParams;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament || !tournament.public_access_enabled) notFound();
  const id = tournament.id;
  const [settings, groups, standings, teams, matches, snapshots, courts] = await Promise.all([
    getScreenSettings(id),
    getGroups(id),
    getStandings(id),
    getTeams(id),
    getMatches(id),
    getSnapshots(id),
    getCourts(id),
  ]);
  const tm = teamMap(teams);
  const snapByMatch = new Map(snapshots.map((s) => [s.match_id, s]));
  const courtName = new Map(courts.map((c) => [c.id, c.court_name]));
  const live = matches.filter((m) => ["live", "paused"].includes(m.status));
  // URL overrides give a court its own permanent scoreboard link, independent
  // of whatever the operator has the main screen showing. Without params the
  // operator's setting still wins, so existing screens are unaffected.
  const VALID_MODES = ["leaderboard", "live_court", "all_live", "bracket", "winner", "sponsors"];
  const mode = (
    overrides.mode && VALID_MODES.includes(overrides.mode)
      ? overrides.mode
      : overrides.court
        ? "live_court"
        : settings.display_mode
  ) as typeof settings.display_mode;
  const focusCourtId = overrides.court ?? settings.focus_court_id;
  const isChess = tournament.sport === "chess";

  const bracket = await getBracket(id);
  const slots = bracket && bracket.status === "published" ? await getBracketSlots(bracket.id) : [];

  const focusMatches =
    mode === "live_court" && focusCourtId
      ? live.filter((m) => m.court_id === focusCourtId)
      : live;

  return (
    <div className={`${settings.theme === "dark" ? "theme-dark" : ""} flex min-h-screen flex-col bg-background text-foreground`}>
      <AutoRefresh seconds={5} />
      <header className="flex items-center justify-between px-8 py-4">
        <h1 className="text-3xl font-bold">{tournament.name}</h1>
        <div className="flex items-center gap-4">
          {tournament.branding_config.clientLogoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tournament.branding_config.clientLogoUrl} alt="" className="h-12" />
          )}
          {tournament.branding_config.moveBeyondLogoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tournament.branding_config.moveBeyondLogoUrl} alt="Move Beyond" className="h-12" />
          )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden px-8 pb-4">
        {(mode === "live_court" || mode === "all_live") && (
          <div className={`grid h-full gap-4 ${focusMatches.length > 1 ? "lg:grid-cols-2" : ""}`}>
            {focusMatches.length === 0 ? (
              <p className="flex items-center justify-center text-3xl text-muted">No live matches right now</p>
            ) : (
              focusMatches.map((m) => {
                const common = {
                  match: m,
                  snapshot: snapByMatch.get(m.id) ?? null,
                  teamA: m.team_a_id ? tm.get(m.team_a_id) : undefined,
                  teamB: m.team_b_id ? tm.get(m.team_b_id) : undefined,
                  big: focusMatches.length <= 2,
                };
                return isChess ? (
                  <ChessLiveCard key={m.id} {...common} boardName={m.court_id ? courtName.get(m.court_id) : undefined} />
                ) : (
                  <LiveMatchCard key={m.id} {...common} courtName={m.court_id ? courtName.get(m.court_id) : undefined} />
                );
              })
            )}
          </div>
        )}

        {mode === "leaderboard" && (
          <div className="grid h-full content-start gap-4 lg:grid-cols-2">
            {groups.map((g) => (
              <div key={g.id} className="card">
                <h3 className="mb-2 text-2xl font-bold">{g.group_name}</h3>
                <div className="text-lg">
                  <StandingsTable standings={standings.filter((s) => s.group_id === g.id)} teams={tm} />
                </div>
              </div>
            ))}
            {groups.length === 0 && (
              <p className="flex items-center justify-center text-3xl text-muted">Leaderboard coming soon</p>
            )}
          </div>
        )}

        {mode === "bracket" &&
          (slots.length > 0 ? (
            <BracketView slots={slots} teams={tm} matches={new Map(matches.map((m) => [m.id, m]))} big />
          ) : (
            <p className="flex h-full items-center justify-center text-3xl text-muted">Bracket coming soon</p>
          ))}

        {mode === "winner" && (
          <div className="flex h-full items-center justify-center">
            <WinnerDisplay podium={podiumFromMatches(matches, tm)} big />
          </div>
        )}

        {mode === "sponsors" && (
          <div className="flex h-full flex-col items-center justify-center gap-8">
            <SponsorRotator
              logos={tournament.branding_config.sponsorLogoUrls ?? []}
              seconds={settings.sponsor_rotation_seconds}
              className="max-h-72 max-w-2xl"
            />
            {(tournament.branding_config.sponsorLogoUrls?.length ?? 0) === 0 && (
              <p className="text-3xl text-muted">Upload sponsor logos in branding settings</p>
            )}
          </div>
        )}
      </main>

      <LowerThird tournament={tournament} big />
    </div>
  );
}
