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
import { orderedRounds } from "@/components/BracketView";
import ChessLiveCard from "@/components/ChessLiveCard";
import SponsorRotator from "@/components/SponsorRotator";
import StandingsTable from "@/components/StandingsTable";
import WinnerDisplay, { podiumFromMatches } from "@/components/WinnerDisplay";
import BroadcastStage from "@/components/broadcast/BroadcastStage";
import LiveFeedProvider from "@/components/broadcast/LiveFeedProvider";
import LiveCourts from "@/components/broadcast/LiveCourts";
import SponsorTicker from "@/components/broadcast/SponsorTicker";
import BreakOverlay from "@/components/broadcast/BreakOverlay";
import CeremonyStage from "@/components/broadcast/CeremonyStage";
import RankingScene, { type RankingRow } from "@/components/broadcast/RankingScene";
import { buildCeremony } from "@/lib/tv/ceremonyServer";
import { getRankingSnapshot, getSessionByTournament, listPublicPlayers } from "@/lib/friendly/data";
import SponsorWatermark from "@/components/broadcast/SponsorWatermark";
import EventBackdrop from "@/components/broadcast/EventBackdrop";
import { backgroundFor } from "@/lib/background";
import { redBlueTeams } from "@/lib/sides";
import { resolveSponsors, surfaceForMode } from "@/lib/sponsors";
import { toPublicTeam } from "@/lib/public";
import { entranceRankFor } from "@/lib/tv/entrance";
import { buildLiveFeed } from "@/lib/tv/liveFeedServer";
import { GUTTER, ROWS, STAGE, bracketFontPx, leaderboardPlan } from "@/lib/tv/layout";
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
  const initialFeed = await buildLiveFeed(id, settings, tournament.updated_at);
  const courtInfo = covered.map((c) => ({ id: c.id, name: c.court_name }));
  const logos = tournament.branding_config;
  const { main: mainSponsor, footer: footerSponsors } = resolveSponsors(logos);
  const backdrop = backgroundFor(logos, "screen");
  const dark = settings.theme === "dark";
  // How loud the glow may be depends on what it sits behind: quiet under a full
  // grid of scores, strongest on the holding slate and the ceremony.
  const shownCount = isChess ? focusMatches.length : pinnedCourtId ? 1 : courtInfo.length;
  const watermarkSurface = surfaceForMode(mode, shownCount);
  // A friendly session has no groups and no bracket: its leaderboard is its
  // ranking, and its podium comes from that ranking.
  const isSession = tournament.kind === "friendly_session";
  // The backing row is named "[Session] …" so it never passes for a tournament in
  // admin lists; the wall shows the session's own name.
  const session = isSession ? await getSessionByTournament(id) : null;
  const displayName = session?.name ?? tournament.name;
  const ceremonyTiers =
    mode === "ceremony" || (mode === "winner" && isSession) ? await buildCeremony(tournament, settings) : [];
  let rankingRows: RankingRow[] = [];
  const rankingTitle = displayName;
  if (mode === "leaderboard" && isSession) {
    if (session) {
      const ranking = await getRankingSnapshot("session", session.id);
      const players = await listPublicPlayers(ranking.map((r) => r.player_profile_id));
      rankingRows = ranking.flatMap((r) => {
        const p = players.get(r.player_profile_id);
        return p
          ? [{
              rank: r.rank,
              points: r.points,
              played: r.matches_played,
              wins: r.wins,
              gameDiff: r.game_diff,
              person: { id: p.id, name: p.public_name, photo_url: p.photo_url, portrait_url: p.portrait_url, focal_x: p.focal_x, focal_y: p.focal_y },
            }]
          : [];
      });
    }
  }

  const holding = {
    title: logos.holding?.title?.trim() || displayName,
    message: logos.holding?.message?.trim() || "Back shortly",
    // The uploaded background finally has a use: the slate's default image.
    imageUrl: logos.holding?.imageUrl || logos.backgroundUrl || null,
  };

  return (
    <BroadcastStage
      className={`${dark ? "theme-dark " : ""}bg-background text-foreground${backdrop ? " bc-has-backdrop" : ""}`}
    >
      <LiveFeedProvider
        slug={slug}
        screenKey={screenKey}
        initial={initialFeed}
        preview={Boolean(overrides.preview)}
        refreshOnScore={isChess}
      >
        {/* The event's own background, at the very back. */}
        {backdrop && <EventBackdrop background={backdrop} variant="stage" />}
        {mode === "holding" && holding.imageUrl && (
          // A solid ground, so the slate's photo covers the event background rather
          // than blending with it.
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-background" style={{ zIndex: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sizedImageSrc(holding.imageUrl, 1920) ?? holding.imageUrl} alt="" loading="eager" className="h-full w-full object-cover opacity-40" />
            {/* A scrim, so the title stays legible over any photograph. */}
            <div
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(to bottom, color-mix(in oklab, var(--background) 70%, transparent), color-mix(in oklab, var(--background) 30%, transparent) 45%, color-mix(in oklab, var(--background) 85%, transparent))",
              }}
            />
          </div>
        )}
        {/* Inside the feed provider, so MUTE ANIMATIONS stills the glow too. */}
        <SponsorWatermark sponsor={mainSponsor} surface={watermarkSurface} backgroundHex={dark ? "#0b0b0b" : "#ffffff"} />

        {/* Three pinned rows that fill the canvas exactly. Each clips its own
            content: a fixed row that overflows still paints into the next one. */}
        <div className="relative grid h-full" style={{ zIndex: 10, gridTemplateRows: `${ROWS.header}px ${ROWS.content}px ${ROWS.ticker}px` }}>
          <header className="flex min-h-0 items-center justify-between gap-8 overflow-hidden px-10">
            <div className="min-w-0">
              <h1 className="truncate text-[44px] font-black leading-tight">{displayName}</h1>
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
              <LiveCourts
                courts={courtInfo}
                teams={publicTeams}
                ranks={ranks}
                pinnedCourtId={pinnedCourtId ?? null}
                sides={redBlueTeams(logos)}
              />
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

            {mode === "leaderboard" && isSession && <RankingScene title={rankingTitle} rows={rankingRows} />}

            {mode === "leaderboard" && !isSession && (() => {
              // Sized from what has to fit: how many tables, and how many teams in
              // the biggest. One table on a wall gets 44px type; six get 19px.
              const byGroup = groups.map((g) => standings.filter((st) => st.group_id === g.id));
              const plan = leaderboardPlan(byGroup.map((rows) => rows.length));
              return (
                <div
                  className="grid h-full content-start overflow-hidden"
                  style={{
                    gridTemplateColumns: `repeat(${plan.columns}, ${plan.cardWidth}px)`,
                    gap: GUTTER,
                    padding: `0 ${GUTTER}px ${GUTTER}px`,
                  }}
                >
                  {groups.map((g, i) => (
                    <div key={g.id} className="bc-card min-w-0 overflow-hidden" style={{ padding: plan.fontPx * 0.6 }}>
                      <h3 className="mb-1 font-bold" style={{ fontSize: Math.round(plan.fontPx * 1.35) }}>
                        {g.group_name}
                      </h3>
                      <StandingsTable standings={byGroup[i]} teams={tm} fontPx={plan.fontPx} detail={plan.detail} />
                    </div>
                  ))}
                  {groups.length === 0 && (
                    <p className="flex items-center justify-center text-[40px] text-muted">Leaderboard coming soon</p>
                  )}
                </div>
              );
            })()}

            {mode === "bracket" &&
              (brackets.length > 0 ? (
                <div className="grid h-full gap-5 overflow-hidden px-5 pb-5" style={{ gridTemplateColumns: brackets.length > 1 ? "1fr 1fr" : "1fr" }}>
                  {brackets.map((bracket, i) => {
                    // Sized from the room this tree has, so a Plate beside a Cup is
                    // still readable rather than dropping to the old 14px.
                    const slots = slotsByBracket[i];
                    const rounds = orderedRounds(slots);
                    const first = rounds[0];
                    const pairs = Math.max(1, Math.ceil(slots.filter((s) => s.round_name === first).length / 2));
                    const width = (STAGE.width - GUTTER * 2 - (brackets.length > 1 ? GUTTER : 0)) / brackets.length;
                    const labelled = brackets.length > 1;
                    const fontPx = bracketFontPx(rounds.length, pairs, width, ROWS.content - GUTTER - (labelled ? 44 : 0));
                    return (
                      <div key={bracket.id} className="flex min-w-0 flex-col overflow-hidden">
                        {labelled && (
                          <p className="mb-1 shrink-0 text-[28px] font-bold uppercase tracking-widest text-muted">
                            {bracket.tier === "plate" ? "Plate" : "Cup"}
                          </p>
                        )}
                        <div className="min-h-0 flex-1">
                          <BracketView
                            slots={slots}
                            teams={tm}
                            matches={new Map(matches.map((m) => [m.id, m]))}
                            fontPx={fontPx}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="flex h-full items-center justify-center text-[40px] text-muted">Bracket coming soon</p>
              ))}

            {mode === "ceremony" && <CeremonyStage tiers={ceremonyTiers} />}

            {mode === "winner" && isSession && <CeremonyStage tiers={ceremonyTiers} finale />}

            {mode === "winner" && !isSession && (
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

            {/* Over whatever the screen is showing, until the operator ends it. */}
            <BreakOverlay title={holding.title} />

            {mode === "holding" && (
              // With a sponsor glowing at the centre, the words sit below the mark
              // rather than over it; without one they take the middle of the frame.
              <div className={`flex h-full flex-col items-center gap-5 px-16 text-center ${mainSponsor ? "justify-end pb-24" : "justify-center"}`}>
                <p className="max-w-[1600px] text-[96px] font-black leading-none">{holding.title}</p>
                <p className="max-w-[1400px] text-[48px] text-muted">{holding.message}</p>
              </div>
            )}

            {mode === "sponsors" && (
              <div className="flex h-full flex-col items-center justify-center gap-8">
                {/* The main sponsor already glows behind this scene, so the rotator
                    shows everyone else — or the main sponsor, when it is alone. */}
                <SponsorRotator
                  logos={(footerSponsors.length > 0 ? footerSponsors : mainSponsor ? [mainSponsor] : []).map((sp) => sp.logoUrl)}
                  seconds={settings.sponsor_rotation_seconds}
                  className="max-h-[480px] max-w-[1200px]"
                />
                {footerSponsors.length === 0 && !mainSponsor && (
                  <p className="text-[40px] text-muted">Upload sponsor logos in branding settings</p>
                )}
              </div>
            )}
          </main>

          {/* The during-play sponsor surface. The full-screen rotator above is the
              between-matches one; showing both at once doubled every logo. */}
          <footer className="min-h-0 overflow-hidden">
            {mode !== "sponsors" && <SponsorTicker main={mainSponsor} sponsors={footerSponsors} />}
          </footer>
        </div>
      </LiveFeedProvider>
    </BroadcastStage>
  );
}
