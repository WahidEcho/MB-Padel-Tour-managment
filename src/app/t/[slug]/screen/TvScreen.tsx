import { notFound } from "next/navigation";
import {
  courtsForScreen,
  defaultScreenSettings,
  getBrackets,
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
import { podiumDepthFor } from "@/lib/bracket";
import { normalizeDisplayMode, type Court, type DisplayMode, type Match } from "@/lib/types";
import BracketView from "@/components/BracketView";
import ChessLiveCard from "@/components/ChessLiveCard";
import SponsorRotator from "@/components/SponsorRotator";
import SponsorMarquee from "@/components/SponsorMarquee";
import StandingsTable from "@/components/StandingsTable";
import WinnerDisplay, { podiumFromMatches } from "@/components/WinnerDisplay";
import BroadcastStage from "@/components/broadcast/BroadcastStage";
import LiveFeedProvider from "@/components/broadcast/LiveFeedProvider";
import LiveCourts from "@/components/broadcast/LiveCourts";
import { toPublicTeam } from "@/lib/public";
import { entranceRankFor } from "@/lib/tv/entrance";
import { buildLiveFeed } from "@/lib/tv/liveFeedServer";
import { ROWS } from "@/lib/tv/layout";
import { sizedImageSrc } from "@/lib/portrait";

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

  // Which bracket the bracket, winner and ceremony scenes show. A screen set to
  // 'both' shows them one after another; otherwise it shows the tier it is set
  // to, falling back to whatever is published when that tier is not.
  const published = (await getBrackets(id)).filter((b) => b.status === "published");
  const shownBrackets =
    settings.bracket_tier === "both"
      ? published
      : published.filter((b) => b.tier === settings.bracket_tier);
  const brackets = shownBrackets.length > 0 ? shownBrackets : published;
  const slotsByBracket = await Promise.all(brackets.map((b) => getBracketSlots(b.id)));

  // ---------- broadcast data, projected for the client ----------
  // Court cards are client components, so their props are serialised into the
  // page. They get public projections only: a raw team row carries the
  // organiser's phone number and internal notes.
  const publicTeams = Object.fromEntries(teams.map((t) => [t.id, toPublicTeam(t)]));
  const groupNames = new Map(groups.map((g) => [g.id, g.group_name]));
  const rankCtx = {
    standings,
    groupNames,
    matches,
    completedSets: new Map(snapshots.map((sn) => [sn.match_id, sn.completed_sets ?? []])),
    teamNames: new Map(teams.map((t) => [t.id, t.team_name])),
  };
  const ranks = Object.fromEntries(
    matches
      .filter((m) => m.team_a_id && m.team_b_id)
      .map((m) => [
        m.id,
        { a: entranceRankFor(m, m.team_a_id!, rankCtx), b: entranceRankFor(m, m.team_b_id!, rankCtx) },
      ]),
  );
  const initialFeed = await buildLiveFeed(id, settings);
  const courtInfo = covered.map((c) => ({ id: c.id, name: c.court_name }));
  const logos = tournament.branding_config;

  return (
    <BroadcastStage className={settings.theme === "dark" ? "theme-dark bg-background text-foreground" : "bg-background text-foreground"}>
      <LiveFeedProvider
        slug={slug}
        screenKey={screenKey}
        initial={initialFeed}
        preview={Boolean(overrides.preview)}
        refreshOnScore={isChess}
      >
        {/* Three pinned rows that fill the canvas exactly. Each clips its own
            content: a fixed row that overflows still paints into the next one. */}
        <div className="grid h-full" style={{ gridTemplateRows: `${ROWS.header}px ${ROWS.content}px ${ROWS.ticker}px` }}>
          <header className="flex min-h-0 items-center justify-between gap-8 overflow-hidden px-10">
            <div className="min-w-0">
              <h1 className="truncate text-[44px] font-black leading-tight">{tournament.name}</h1>
              <p className="truncate text-[24px] uppercase tracking-widest text-muted">
                {[settings.screen_name, tournament.lower_third_text].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-6">
              {logos.clientLogoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={sizedImageSrc(logos.clientLogoUrl, 320) ?? ""} alt="" loading="eager" className="h-[60px] w-auto object-contain" />
              )}
              {logos.moveBeyondLogoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={sizedImageSrc(logos.moveBeyondLogoUrl, 320) ?? ""} alt="Move Beyond" loading="eager" className="h-[60px] w-auto object-contain" />
              )}
            </div>
          </header>

          <main className="relative min-h-0 overflow-hidden">
            {mode === "live" && !isChess && (
              <LiveCourts courts={courtInfo} teams={publicTeams} ranks={ranks} pinnedCourtId={pinnedCourtId ?? null} />
            )}

            {mode === "live" && isChess && (
              <div className={`grid h-full gap-5 px-5 pb-5 ${focusMatches.length > 1 ? "grid-cols-2" : ""}`}>
                {focusMatches.length === 0 ? (
                  <p className="flex items-center justify-center text-[40px] text-muted">No live boards right now</p>
                ) : (
                  focusMatches.map((m) => (
                    <ChessLiveCard
                      key={m.id}
                      match={m}
                      snapshot={snapByMatch.get(m.id) ?? null}
                      teamA={m.team_a_id ? tm.get(m.team_a_id) : undefined}
                      teamB={m.team_b_id ? tm.get(m.team_b_id) : undefined}
                      big={focusMatches.length <= 2}
                      boardName={m.court_id ? courtName.get(m.court_id) : undefined}
                    />
                  ))
                )}
              </div>
            )}

            {mode === "leaderboard" && (
              <div className="grid h-full content-start gap-5 overflow-hidden px-5 pb-5" style={{ gridTemplateColumns: "1fr 1fr" }}>
                {groups.map((g) => (
                  <div key={g.id} className="bc-card p-5">
                    <h3 className="mb-2 text-[34px] font-bold">{g.group_name}</h3>
                    <div className="text-[24px]">
                      <StandingsTable standings={standings.filter((st) => st.group_id === g.id)} teams={tm} />
                    </div>
                  </div>
                ))}
                {groups.length === 0 && (
                  <p className="col-span-2 flex items-center justify-center text-[40px] text-muted">Leaderboard coming soon</p>
                )}
              </div>
            )}

            {mode === "bracket" &&
              (brackets.length > 0 ? (
                <div className="grid h-full gap-5 overflow-hidden px-5 pb-5" style={{ gridTemplateColumns: brackets.length > 1 ? "1fr 1fr" : "1fr" }}>
                  {brackets.map((bracket, i) => (
                    <div key={bracket.id} className="min-w-0 overflow-hidden">
                      {brackets.length > 1 && (
                        <p className="mb-1 text-[28px] font-bold uppercase tracking-widest text-muted">
                          {bracket.tier === "plate" ? "Plate" : "Cup"}
                        </p>
                      )}
                      <BracketView
                        slots={slotsByBracket[i]}
                        teams={tm}
                        matches={new Map(matches.map((m) => [m.id, m]))}
                        big={brackets.length === 1}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="flex h-full items-center justify-center text-[40px] text-muted">Bracket coming soon</p>
              ))}

            {(mode === "winner" || mode === "ceremony") && (
              <div className="flex h-full flex-col items-center justify-center gap-6 overflow-hidden px-10">
                {(brackets.length > 0 ? brackets : [null]).map((bracket) => (
                  <WinnerDisplay
                    key={bracket?.id ?? "cup"}
                    title={brackets.length > 1 ? (bracket?.tier === "plate" ? "Plate" : "Cup") : undefined}
                    podium={podiumFromMatches(matches, tm, {
                      tier: bracket?.tier ?? "cup",
                      bracketId: bracket?.id ?? undefined,
                      depth: podiumDepthFor(tournament.format_config, bracket?.tier ?? "cup"),
                    })}
                    big
                  />
                ))}
              </div>
            )}

            {mode === "holding" && (
              <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
                <p className="text-[96px] font-black leading-none">{tournament.name}</p>
                <p className="text-[48px] text-muted">Back shortly</p>
              </div>
            )}

            {mode === "sponsors" && (
              <div className="flex h-full flex-col items-center justify-center gap-8">
                <SponsorRotator
                  logos={logos.sponsorLogoUrls ?? []}
                  seconds={settings.sponsor_rotation_seconds}
                  className="max-h-[480px] max-w-[1200px]"
                />
                {(logos.sponsorLogoUrls?.length ?? 0) === 0 && (
                  <p className="text-[40px] text-muted">Upload sponsor logos in branding settings</p>
                )}
              </div>
            )}
          </main>

          {/* The during-play sponsor surface. The full-screen rotator above is the
              between-matches one; showing both at once doubled every logo. */}
          <footer className="min-h-0 overflow-hidden">
            {mode !== "sponsors" && <SponsorMarquee logos={logos.sponsorLogoUrls ?? []} label="" size="big" />}
          </footer>
        </div>
      </LiveFeedProvider>
    </BroadcastStage>
  );
}
