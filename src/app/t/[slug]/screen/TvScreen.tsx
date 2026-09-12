import { notFound } from "next/navigation";
import {
  courtsForScreen,
  defaultScreenSettings,
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
import { MAIN_SCREEN, isValidScreenKey } from "@/lib/screens";
import { normalizeDisplayMode, type Court, type DisplayMode, type Match } from "@/lib/types";
import AutoRefresh from "@/components/AutoRefresh";
import BracketView from "@/components/BracketView";
import LiveMatchCard from "@/components/LiveMatchCard";
import ChessLiveCard from "@/components/ChessLiveCard";
import LowerThird from "@/components/LowerThird";
import SponsorRotator from "@/components/SponsorRotator";
import SponsorMarquee from "@/components/SponsorMarquee";
import StandingsTable from "@/components/StandingsTable";
import WinnerDisplay, { podiumFromMatches } from "@/components/WinnerDisplay";

const VALID_MODES: DisplayMode[] = [
  "live",
  "leaderboard",
  "bracket",
  "winner",
  "ceremony",
  "sponsors",
  "holding",
  "live_court",
  "all_live",
];

/**
 * Resolves a `?court=` override by name rather than by id.
 *
 * The override exists so a court can be given a hand-typed permanent link, and
 * nobody hand-types a UUID. Names are not unique in the schema, so this matches
 * case-insensitively on the trimmed name and takes the lowest court order when
 * two courts share one.
 */
function courtByName(courts: Court[], name: string): Court | undefined {
  const wanted = name.trim().toLowerCase();
  return courts
    .filter((c) => c.court_name.trim().toLowerCase() === wanted)
    .sort((a, b) => a.court_order - b.court_order)[0];
}

/**
 * The venue screen.
 *
 * Shared by `/t/<slug>/screen` (the main screen) and `/t/<slug>/screen/<key>`,
 * so a venue can drive several walls from one tournament, each covering its own
 * courts, each with its own link and its own control page.
 */
export default async function TvScreen({
  slug,
  screenKey = MAIN_SCREEN,
  overrides,
}: {
  slug: string;
  screenKey?: string;
  overrides: { court?: string; mode?: string; preview?: string };
}) {
  if (!isValidScreenKey(screenKey)) notFound();

  const tournament = await getTournamentBySlug(slug);
  if (!tournament || !tournament.public_access_enabled) notFound();
  const id = tournament.id;

  const stored = await getScreenSettings(id, screenKey);
  // A screen that was never configured is only meaningful for `main`, which is
  // the tournament's own screen and must never 404. Any other key with no row
  // is a screen that does not exist, or one an admin deleted while a TV was
  // still open on it — that TV should stop showing stale content, not resurrect
  // the row by being read.
  if (!stored && screenKey !== MAIN_SCREEN) notFound();
  const settings = stored ?? defaultScreenSettings(id, screenKey);

  const [groups, standings, teams, matches, snapshots, courts] = await Promise.all([
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
  const isChess = tournament.sport === "chess";

  // URL overrides give a court its own permanent link, independent of whatever
  // the operator has this screen showing. Without params the stored settings
  // win, so an existing screen is unaffected.
  const override = overrides.court ? courtByName(courts, overrides.court) : undefined;
  const requestedMode = overrides.mode as DisplayMode | undefined;
  const mode = normalizeDisplayMode(
    requestedMode && VALID_MODES.includes(requestedMode)
      ? requestedMode
      : override
        ? "live"
        : settings.display_mode,
  );

  // Coverage filters, then the pin narrows within it. The absence of both pins
  // is what "follow live" means; there is no separate flag that could disagree.
  const covered = courtsForScreen(settings, courts);
  const coveredIds = new Set(covered.map((c) => c.id));
  const pinnedCourtId = override?.id ?? settings.focus_court_id;

  const live = matches.filter(
    (m) => ["live", "paused"].includes(m.status) && (m.court_id ? coveredIds.has(m.court_id) : true),
  );
  let focusMatches: Match[] = live;
  if (settings.focus_match_id) {
    focusMatches = matches.filter((m) => m.id === settings.focus_match_id);
  } else if (pinnedCourtId) {
    focusMatches = live.filter((m) => m.court_id === pinnedCourtId);
  }

  const bracket = await getBracket(id);
  const slots = bracket && bracket.status === "published" ? await getBracketSlots(bracket.id) : [];

  return (
    <div
      className={`${settings.theme === "dark" ? "theme-dark" : ""} flex min-h-screen flex-col bg-background text-foreground`}
    >
      {/* A control-room thumbnail polls more slowly than the wall it mirrors, so
          a console showing several screens does not multiply the render load. */}
      <AutoRefresh seconds={overrides.preview ? 10 : 5} />
      <header className="flex items-center justify-between px-8 py-4">
        <div>
          <h1 className="text-3xl font-bold">{tournament.name}</h1>
          {settings.screen_name && (
            <p className="text-sm uppercase tracking-widest text-muted">{settings.screen_name}</p>
          )}
        </div>
        <div className="flex items-center gap-4">
          {tournament.branding_config.clientLogoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tournament.branding_config.clientLogoUrl} alt="" loading="eager" className="h-12" />
          )}
          {tournament.branding_config.moveBeyondLogoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tournament.branding_config.moveBeyondLogoUrl} alt="Move Beyond" loading="eager" className="h-12" />
          )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden px-8 pb-4">
        {mode === "live" && (
          <div className={`grid h-full gap-4 ${focusMatches.length > 1 ? "lg:grid-cols-2" : ""}`}>
            {focusMatches.length === 0 ? (
              <p className="flex items-center justify-center text-3xl text-muted">
                {covered.length < courts.length
                  ? `No live matches on ${covered.map((c) => c.court_name).join(", ") || "this screen"}`
                  : "No live matches right now"}
              </p>
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

        {(mode === "winner" || mode === "ceremony") && (
          <div className="flex h-full items-center justify-center">
            <WinnerDisplay podium={podiumFromMatches(matches, tm)} big />
          </div>
        )}

        {mode === "holding" && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <p className="text-6xl font-bold">{tournament.name}</p>
            <p className="text-3xl text-muted">Back shortly</p>
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

      {/* A continuous sponsor ribbon along the bottom of the venue screen.
          The dedicated "sponsors" display mode still shows them full-screen;
          this keeps them visible during live scoring too. */}
      {mode !== "sponsors" && (
        <SponsorMarquee logos={tournament.branding_config.sponsorLogoUrls ?? []} label="" size="big" />
      )}

      <LowerThird tournament={tournament} big />
    </div>
  );
}
